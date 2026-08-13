import { Prisma, Order, OrderType, OrderSide } from '@prisma/client';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { MarketSimulatorService, MarketTick } from '../services/market-simulator.service';
import pino from 'pino';
import Redis from 'ioredis';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, ignore: 'pid,hostname' }
  }
});

export class TradingEngine {
  private readonly executionQueue: Queue;
  private readonly redis: Redis;
  private orders: Map<string, Map<string, Order>> = new Map(); // symbol -> Map<orderId, Order>

  constructor(
    redisUrl: string,
    private readonly simulator: MarketSimulatorService,
    queueName: string = 'tradealpha-execution'
  ) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.executionQueue = new Queue(queueName, { connection: this.redis });

    // Subscribe to market ticks
    this.simulator.on('tick', this.handleTick.bind(this));
  }

  public async close(): Promise<void> {
    await this.executionQueue.close();
    await this.redis.quit();
  }

  public addOrder(order: Order): void {
    if (!this.orders.has(order.symbol)) {
      this.orders.set(order.symbol, new Map());
    }
    this.orders.get(order.symbol)!.set(order.id, order);
    logger.info({ orderId: order.id, symbol: order.symbol }, 'Order added to Trading Engine in-memory book');
  }

  public removeOrder(symbol: string, orderId: string): void {
    if (this.orders.has(symbol)) {
      this.orders.get(symbol)!.delete(orderId);
      logger.info({ orderId, symbol }, 'Order removed from Trading Engine in-memory book');
    }
  }

  private async handleTick(tick: MarketTick): Promise<void> {
    const symbolOrders = this.orders.get(tick.symbol);
    if (!symbolOrders || symbolOrders.size === 0) return;

    const tickPrice = new Prisma.Decimal(tick.price);

    for (const [orderId, order] of symbolOrders.entries()) {
      if (this.isExecutable(order, tickPrice)) {
        await this.triggerExecution(order, tickPrice);
      }
    }
  }

  private isExecutable(order: Order, tickPrice: Prisma.Decimal): boolean {
    if (order.type === OrderType.MARKET) {
      return true; // Always trigger on next tick
    }
    
    if (order.type === OrderType.LIMIT) {
      const limitPrice = new Prisma.Decimal(order.limitPrice!);
      if (order.side === OrderSide.BUY && tickPrice.lte(limitPrice)) {
        return true;
      }
      if (order.side === OrderSide.SELL && tickPrice.gte(limitPrice)) {
        return true;
      }
    }
    return false;
  }

  private async triggerExecution(order: Order, tickPrice: Prisma.Decimal): Promise<void> {
    const executionIdempotencyKey = randomUUID();
    const requestedQty = new Prisma.Decimal(order.requestedQuantity);
    const filledQty = new Prisma.Decimal(order.filledQuantity);
    const remainingQty = requestedQty.minus(filledQty);

    if (remainingQty.lte(0)) {
      this.removeOrder(order.symbol, order.id);
      return;
    }

    // Queue the EXECUTE_FILL job
    await this.executionQueue.add(
      'EXECUTE_FILL',
      {
        orderId: order.id,
        price: tickPrice.toString(), // primitive string across BullMQ
        quantity: remainingQty.toString(), // Full remaining quantity per Phase 2.6 Partial Fill Model
        executionIdempotencyKey
      },
      {
        jobId: executionIdempotencyKey, // deduplicate exactly identical executions in BullMQ natively
        attempts: 10,
        backoff: { type: 'exponential', delay: 1000 }
      }
    );

    logger.info({ orderId: order.id, price: tickPrice.toString(), executionIdempotencyKey }, 'Queued EXECUTE_FILL job');

    // Remove from in-memory book to prevent redundant trigger on next tick
    // If execution fails, it retries in BullMQ, NOT via another market tick.
    this.removeOrder(order.symbol, order.id);
  }
}
