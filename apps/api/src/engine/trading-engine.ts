import { Prisma, Order, OrderType, OrderSide, PrismaClient, OrderStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { MarketSimulatorService, MarketTick } from '../services/market-simulator.service';
import { OrderService } from '../services/order.service';
import pino from 'pino';
import Redis from 'ioredis';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, ignore: 'pid,hostname' }
  }
});

type EngineOrderState = 'READY' | 'QUEUED';

interface EngineOrder {
  order: Order;
  state: EngineOrderState;
}

export class TradingEngine {
  private readonly executionQueue: Queue;
  private readonly redis: Redis;
  private readonly prisma: PrismaClient;
  private readonly orderService: OrderService;
  
  // symbol -> Map<orderId, EngineOrder>
  private orders: Map<string, Map<string, EngineOrder>> = new Map();
  private reconciliationInterval?: NodeJS.Timeout;

  constructor(
    redisUrl: string,
    private readonly simulator: MarketSimulatorService,
    prisma: PrismaClient,
    orderService: OrderService,
    queueName: string = 'tradealpha-execution'
  ) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.executionQueue = new Queue(queueName, { connection: this.redis });
    this.prisma = prisma;
    this.orderService = orderService;

    // Subscribe to market ticks
    this.simulator.on('tick', this.handleTick.bind(this));
  }

  public async close(): Promise<void> {
    this.stopReconciliation();
    await this.executionQueue.close();
    await this.redis.quit();
  }

  /**
   * Loads all actionable orders from the database into the engine.
   * MUST be called before starting reconciliation or dispatchers to prevent race conditions.
   */
  public async hydrate(): Promise<void> {
    const orders = await this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.PENDING, OrderStatus.PARTIALLY_FILLED] }
      }
    });

    let hydratedCount = 0;
    for (const order of orders) {
      const requestedQty = new Prisma.Decimal(order.requestedQuantity);
      const filledQty = new Prisma.Decimal(order.filledQuantity);
      if (requestedQty.minus(filledQty).gt(0)) {
        this.addOrder(order);
        hydratedCount++;
      }
    }
    
    logger.info({ count: hydratedCount }, '[Boot] TradingEngine hydrated orders');
  }

  public startReconciliation(intervalMs: number = 30000): void {
    if (this.reconciliationInterval) return;
    this.reconciliationInterval = setInterval(async () => {
      try {
        await this.reconcile();
      } catch (err) {
        logger.error({ err }, '[Reconciliation] Failed to run reconciliation');
      }
    }, intervalMs);
    logger.info(`[Boot] Periodic reconciliation started every ${intervalMs}ms`);
  }

  public stopReconciliation(): void {
    if (this.reconciliationInterval) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = undefined;
    }
  }

  private async reconcile(): Promise<void> {
    const orders = await this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.PENDING, OrderStatus.PARTIALLY_FILLED] }
      }
    });

    let recoveredCount = 0;
    for (const order of orders) {
      const requestedQty = new Prisma.Decimal(order.requestedQuantity);
      const filledQty = new Prisma.Decimal(order.filledQuantity);
      if (requestedQty.minus(filledQty).gt(0)) {
        let exists = false;
        if (this.orders.has(order.symbol)) {
          exists = this.orders.get(order.symbol)!.has(order.id);
        }
        
        if (!exists) {
          this.addOrder(order);
          recoveredCount++;
        }
      }
    }

    if (recoveredCount > 0) {
      logger.info({ recoveredCount }, '[Reconciliation] Recovered orphaned orders');
    }
  }

  public addOrder(order: Order): void {
    if (!this.orders.has(order.symbol)) {
      this.orders.set(order.symbol, new Map());
    }
    // Idempotent insertion: overwrites if exists. Status defaults to READY.
    // If it was QUEUED, overwriting with READY is correct because if the order is being
    // re-added, it implies it wasn't filled.
    this.orders.get(order.symbol)!.set(order.id, { order, state: 'READY' });
    logger.info({ orderId: order.id, symbol: order.symbol }, '[Engine] Order added to Trading Engine in-memory book');
  }

  public removeOrder(orderId: string, symbol?: string): void {
    if (symbol) {
      if (this.orders.has(symbol)) {
        if (this.orders.get(symbol)!.delete(orderId)) {
          logger.info({ orderId, symbol }, '[Engine] Order removed due to TERMINAL state');
        }
      }
    } else {
      // Search all symbols if symbol not provided
      for (const [sym, book] of this.orders.entries()) {
        if (book.has(orderId)) {
          book.delete(orderId);
          logger.info({ orderId, symbol: sym }, '[Engine] Order removed due to TERMINAL state');
          break;
        }
      }
    }
  }

  private async handleTick(tick: MarketTick): Promise<void> {
    const symbolOrders = this.orders.get(tick.symbol);
    if (!symbolOrders || symbolOrders.size === 0) return;

    const tickPrice = new Prisma.Decimal(tick.price);

    for (const engineOrder of symbolOrders.values()) {
      if (engineOrder.state === 'QUEUED') {
        continue; // Prevent duplicate execution dispatch
      }

      await this.evaluateOrder(engineOrder, tickPrice);
    }
  }

  private async evaluateOrder(engineOrder: EngineOrder, tickPrice: Prisma.Decimal): Promise<void> {
    const { order } = engineOrder;

    // 1. Evaluate STOP triggers
    if (order.type === OrderType.STOP) {
      const stopPrice = new Prisma.Decimal(order.stopPrice!);
      const triggered = (order.side === OrderSide.BUY && tickPrice.gte(stopPrice)) ||
                        (order.side === OrderSide.SELL && tickPrice.lte(stopPrice));
      
      if (triggered) {
        logger.info({ orderId: order.id, tickPrice: tickPrice.toString() }, '[Engine] STOP triggered, converting to MARKET execution');
        await this.triggerExecution(engineOrder, tickPrice);
      }
      return;
    }

    // 2. Evaluate STOP_LIMIT triggers
    if (order.type === OrderType.STOP_LIMIT) {
      if (!order.isActivated) {
        const stopPrice = new Prisma.Decimal(order.stopPrice!);
        const triggered = (order.side === OrderSide.BUY && tickPrice.gte(stopPrice)) ||
                          (order.side === OrderSide.SELL && tickPrice.lte(stopPrice));
        
        if (triggered) {
          logger.info({ orderId: order.id, tickPrice: tickPrice.toString() }, '[Engine] STOP_LIMIT activated');
          try {
            // Optimistically update in-memory state to prevent double-activation race conditions 
            // if multiple ticks arrive before the DB call resolves.
            order.isActivated = true;
            
            // Atomically persist activation in DB
            const activatedOrder = await this.orderService.activateStopLimit(order.id);
            // Confirm with DB state
            engineOrder.order = activatedOrder;
          } catch (err) {
            order.isActivated = false; // Revert on failure
            logger.error({ err, orderId: order.id }, '[Engine] Failed to activate STOP_LIMIT order in DB');
            return; // Abort this evaluation, wait for next tick to retry
          }
        } else {
          return; // Not activated yet
        }
      }
      
      // If we reach here, it is activated. Evaluate as LIMIT.
      const limitPrice = new Prisma.Decimal(order.limitPrice!);
      const canFill = (order.side === OrderSide.BUY && tickPrice.lte(limitPrice)) ||
                      (order.side === OrderSide.SELL && tickPrice.gte(limitPrice));
      
      if (canFill) {
        await this.triggerExecution(engineOrder, tickPrice);
      }
      return;
    }

    // 3. Evaluate standard MARKET / LIMIT
    if (order.type === OrderType.MARKET) {
      await this.triggerExecution(engineOrder, tickPrice);
      return;
    }

    if (order.type === OrderType.LIMIT) {
      const limitPrice = new Prisma.Decimal(order.limitPrice!);
      const canFill = (order.side === OrderSide.BUY && tickPrice.lte(limitPrice)) ||
                      (order.side === OrderSide.SELL && tickPrice.gte(limitPrice));
      if (canFill) {
        await this.triggerExecution(engineOrder, tickPrice);
      }
      return;
    }
  }

  private async triggerExecution(engineOrder: EngineOrder, tickPrice: Prisma.Decimal): Promise<void> {
    const order = engineOrder.order;
    const requestedQty = new Prisma.Decimal(order.requestedQuantity);
    const filledQty = new Prisma.Decimal(order.filledQuantity);
    const remainingQty = requestedQty.minus(filledQty);

    if (remainingQty.lte(0)) {
      this.removeOrder(order.id, order.symbol);
      return;
    }

    // Mark as QUEUED to prevent duplicate triggers on subsequent ticks
    engineOrder.state = 'QUEUED';

    // Deterministic execution identity: ensures if we crash and retry, BullMQ deduplicates it.
    const executionIdempotencyKey = `exec_${order.id}_${filledQty.toString()}`;

    // Queue the EXECUTE_FILL job
    await this.executionQueue.add(
      'EXECUTE_FILL',
      {
        orderId: order.id,
        price: tickPrice.toString(), 
        quantity: remainingQty.toString(), 
        executionIdempotencyKey
      },
      {
        jobId: executionIdempotencyKey, 
        attempts: 10,
        backoff: { type: 'exponential', delay: 1000 }
      }
    );

    logger.info({ orderId: order.id, price: tickPrice.toString(), executionIdempotencyKey }, '[Engine] Queued EXECUTE_FILL job, state->QUEUED');
  }
}
