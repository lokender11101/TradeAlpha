import { Prisma, Order, OrderType, OrderSide, PrismaClient, OrderStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { OrderService } from '../services/order.service';
import { PriceCacheService } from '../services/price-cache.service';
import pino from 'pino';
import Redis from 'ioredis';
import * as crypto from 'crypto';
import { MarketTick } from '../services/market-simulator.service';

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
  correlationId?: string;
}

const LUA_HEARTBEAT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], 15)
else
  return 0
end
`;

const LUA_RELEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export class TradingEngine {
  private readonly executionQueue: Queue;
  private readonly redis: Redis;
  private readonly subscriber: Redis;
  private readonly prisma: PrismaClient;
  private readonly orderService: OrderService;
  private readonly priceCache: PriceCacheService;
  private readonly processToken: string;
  private readonly assignedSymbols: string[];
  
  private ownedSymbols: Set<string> = new Set();
  // symbol -> Map<orderId, EngineOrder>
  private orders: Map<string, Map<string, EngineOrder>> = new Map();
  
  private reconciliationInterval?: NodeJS.Timeout;
  private heartbeatInterval?: NodeJS.Timeout;

  constructor(
    redisUrl: string,
    prisma: PrismaClient,
    orderService: OrderService,
    priceCache: PriceCacheService,
    assignedSymbols: string[],
    queueName: string = 'tradealpha-execution'
  ) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.executionQueue = new Queue(queueName, { connection: this.redis });
    this.prisma = prisma;
    this.orderService = orderService;
    this.priceCache = priceCache;
    this.assignedSymbols = assignedSymbols;
    this.processToken = crypto.randomUUID();

    this.subscriber.on('message', this.handlePubSubMessage.bind(this));
  }

  public async start(): Promise<void> {
    await this.acquireLeases();
    await this.hydrate();
    this.startHeartbeat(10000);
    this.startReconciliation(30000);
  }

  public async close(): Promise<void> {
    this.stopReconciliation();
    this.stopHeartbeat();
    await this.releaseLeases();
    await this.executionQueue.close();
    await this.subscriber.quit();
    await this.redis.quit();
  }

  private async acquireLeases(): Promise<void> {
    for (const symbol of this.assignedSymbols) {
      const key = `engine:symbol:${symbol}`;
      const acquired = await this.redis.set(key, this.processToken, 'EX', 15, 'NX');
      if (!acquired) {
        logger.fatal({ symbol }, '[Engine] FATAL: Could not acquire lease for symbol. Another engine is active! Failing fast.');
        process.exit(1);
      }
      this.ownedSymbols.add(symbol);
      logger.info({ symbol, token: this.processToken }, '[Engine] Acquired symbol lease');
      await this.subscriber.subscribe(`market:tick:${symbol}`);
      await this.subscriber.subscribe(`engine:route:${symbol}`);
    }
  }

  private async releaseLeases(): Promise<void> {
    for (const symbol of this.ownedSymbols) {
      const key = `engine:symbol:${symbol}`;
      await this.redis.eval(LUA_RELEASE, 1, key, this.processToken);
      logger.info({ symbol }, '[Engine] Released symbol lease');
    }
    this.ownedSymbols.clear();
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(async () => {
      for (const symbol of this.ownedSymbols) {
        const key = `engine:symbol:${symbol}`;
        try {
          const res = await this.redis.eval(LUA_HEARTBEAT, 1, key, this.processToken);
          if (res === 0) {
            this.handleLeaseLoss(symbol);
          }
        } catch (err) {
          logger.error({ err, symbol }, '[Engine] Heartbeat Lua script failed');
        }
      }
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  private handleLeaseLoss(symbol: string): void {
    logger.fatal({ symbol }, '[Engine] FATAL: Lease LOST. Halting all processing for symbol.');
    this.ownedSymbols.delete(symbol);
    this.subscriber.unsubscribe(`market:tick:${symbol}`).catch(() => {});
    this.orders.delete(symbol);
  }

  /**
   * Loads all actionable orders from the database into the engine for OWNED symbols.
   * Immediately evaluates against PriceCache to recover missed STOP boundaries.
   */
  public async hydrate(): Promise<void> {
    if (this.ownedSymbols.size === 0) return;

    const orders = await this.prisma.order.findMany({
      where: {
        symbol: { in: Array.from(this.ownedSymbols) },
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

    // Immediate missed-tick recovery
    for (const symbol of this.ownedSymbols) {
      const { price, isStale } = await this.priceCache.getLatestPrice(symbol);
      if (!isStale && price) {
        const tickPrice = new Prisma.Decimal(price);
        const symbolOrders = this.orders.get(symbol);
        if (symbolOrders) {
          for (const engineOrder of symbolOrders.values()) {
            if (engineOrder.state === 'QUEUED') continue;
            // STALE OWNER FENCING check
            if (!this.ownedSymbols.has(symbol)) continue;
            await this.evaluateOrder(engineOrder, tickPrice);
          }
        }
      }
    }
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
    if (this.ownedSymbols.size === 0) return;

    const orders = await this.prisma.order.findMany({
      where: {
        symbol: { in: Array.from(this.ownedSymbols) },
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
      // Re-evaluate immediately
      for (const symbol of this.ownedSymbols) {
        const { price, isStale } = await this.priceCache.getLatestPrice(symbol);
        if (!isStale && price) {
          const tickPrice = new Prisma.Decimal(price);
          const symbolOrders = this.orders.get(symbol);
          if (symbolOrders) {
            for (const engineOrder of symbolOrders.values()) {
              if (engineOrder.state === 'QUEUED') continue;
              if (!this.ownedSymbols.has(symbol)) continue;
              await this.evaluateOrder(engineOrder, tickPrice);
            }
          }
        }
      }
    }
  }

  private addOrder(order: Order, correlationId?: string): void {
    if (!this.ownedSymbols.has(order.symbol)) return;
    
    let book = this.orders.get(order.symbol);
    if (!book) {
      book = new Map<string, EngineOrder>();
      this.orders.set(order.symbol, book);
    }
    
    const existing = book.get(order.id);
    if (existing && existing.state === 'QUEUED') {
      logger.debug({ orderId: order.id }, '[Engine] Ignoring addOrder because it is currently QUEUED');
      return;
    }

    book.set(order.id, { order, state: 'READY', correlationId });
    logger.info({ orderId: order.id, symbol: order.symbol, correlationId }, '[Engine] Order added/updated in memory');
  }

  public removeOrder(orderId: string, symbol?: string): void {
    if (symbol) {
      if (this.orders.has(symbol)) {
        if (this.orders.get(symbol)!.delete(orderId)) {
          logger.info({ orderId, symbol }, '[Engine] Order removed due to TERMINAL state');
        }
      }
    } else {
      for (const [sym, book] of this.orders.entries()) {
        if (book.has(orderId)) {
          book.delete(orderId);
          logger.info({ orderId, symbol: sym }, '[Engine] Order removed due to TERMINAL state');
          break;
        }
      }
    }
  }

  private handlePubSubMessage(channel: string, message: string): void {
    if (channel.startsWith('engine:route:')) {
      try {
        const payload = JSON.parse(message);
        if (!this.ownedSymbols.has(payload.symbol)) {
          return;
        }
        
        // Asynchronously hydrate from authoritative source
        this.prisma.order.findUnique({ where: { id: payload.orderId } })
          .then(order => {
            if (order && this.ownedSymbols.has(order.symbol)) {
               const requestedQty = new Prisma.Decimal(order.requestedQuantity);
               const filledQty = new Prisma.Decimal(order.filledQuantity);
               if (requestedQty.minus(filledQty).gt(0) && (order.status === 'PENDING' || order.status === 'PARTIALLY_FILLED')) {
                 this.addOrder(order, payload.correlationId);
               }
            }
          })
          .catch(err => logger.error({ err, orderId: payload.orderId }, 'Failed to hydrate routed order'));
      } catch (err) {
        logger.error({ err }, 'Failed to parse pubsub route');
      }
      return;
    }

    if (channel.startsWith('market:tick:')) {
      try {
        const payload = JSON.parse(message);
        // STALE OWNER FENCING
        if (!this.ownedSymbols.has(payload.symbol)) {
          return;
        }
        
        const tickPrice = new Prisma.Decimal(payload.price);
        const symbolOrders = this.orders.get(payload.symbol);
        if (!symbolOrders || symbolOrders.size === 0) return;

        for (const engineOrder of symbolOrders.values()) {
          if (engineOrder.state === 'QUEUED') continue;
          
          // FENCING MID-TICK
          if (!this.ownedSymbols.has(payload.symbol)) {
             return; 
          }
          this.evaluateOrder(engineOrder, tickPrice).catch((err) => {
             logger.error({err, orderId: engineOrder.order.id}, 'Error evaluating order');
          });
        }
      } catch (err) {
        logger.error({ err }, 'Failed to parse pubsub tick');
      }
    }
  }

  private async evaluateOrder(engineOrder: EngineOrder, tickPrice: Prisma.Decimal): Promise<void> {
    const { order } = engineOrder;

    // Fencing
    if (!this.ownedSymbols.has(order.symbol)) return;

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

    if (order.type === OrderType.STOP_LIMIT) {
      if (!order.isActivated) {
        const stopPrice = new Prisma.Decimal(order.stopPrice!);
        const triggered = (order.side === OrderSide.BUY && tickPrice.gte(stopPrice)) ||
                          (order.side === OrderSide.SELL && tickPrice.lte(stopPrice));
        
        if (triggered) {
          logger.info({ orderId: order.id, tickPrice: tickPrice.toString() }, '[Engine] STOP_LIMIT activated');
          try {
            order.isActivated = true;
            const activatedOrder = await this.orderService.activateStopLimit(order.id);
            // Re-check fencing after await!
            if (!this.ownedSymbols.has(order.symbol)) return;
            engineOrder.order = activatedOrder;
          } catch (err) {
            order.isActivated = false;
            logger.error({ err, orderId: order.id }, '[Engine] Failed to activate STOP_LIMIT order in DB');
            return; 
          }
        } else {
          return; 
        }
      }
      
      const limitPrice = new Prisma.Decimal(order.limitPrice!);
      const canFill = (order.side === OrderSide.BUY && tickPrice.lte(limitPrice)) ||
                      (order.side === OrderSide.SELL && tickPrice.gte(limitPrice));
      
      if (canFill) {
        await this.triggerExecution(engineOrder, tickPrice);
      }
      return;
    }

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
    
    // Strict Stale Owner Fencing before dispatch
    if (!this.ownedSymbols.has(order.symbol)) return;

    const requestedQty = new Prisma.Decimal(order.requestedQuantity);
    const filledQty = new Prisma.Decimal(order.filledQuantity);
    const remainingQty = requestedQty.minus(filledQty);

    if (remainingQty.lte(0)) {
      this.removeOrder(order.id, order.symbol);
      return;
    }

    engineOrder.state = 'QUEUED';

    const resultingFilledQuantity = filledQty.add(remainingQty);
    // Canonicalize string representation by parsing through Number or just stringifying the Decimal
    const executionIdempotencyKey = `exec_${order.id}_${resultingFilledQuantity.toNumber()}`;

    await this.executionQueue.add(
      'EXECUTE_FILL',
      {
        orderId: order.id,
        price: tickPrice.toString(), 
        quantity: remainingQty.toString(), 
        executionIdempotencyKey,
        correlationId: engineOrder.correlationId
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
