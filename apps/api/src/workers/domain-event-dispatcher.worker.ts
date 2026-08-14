import { Worker, Job } from 'bullmq';
import { Emitter } from '@socket.io/redis-emitter';
import Redis from 'ioredis';
import pino from 'pino';
import { EventEnvelope } from '../websocket';
import { TradingEngine } from '../engine/trading-engine';
import { OrderService } from '../services/order.service';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, ignore: 'pid,hostname' }
  }
});

export class DomainEventDispatcherWorker {
  private readonly worker: Worker;
  private readonly redis: Redis;
  private readonly emitter: Emitter;
  private readonly tradingEngine: TradingEngine;
  private readonly orderService: OrderService;

  constructor(
    redisUrl: string,
    tradingEngine: TradingEngine,
    orderService: OrderService,
    queueName: string = 'tradealpha-domain-events'
  ) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.emitter = new Emitter(this.redis);
    this.tradingEngine = tradingEngine;
    this.orderService = orderService;

    this.worker = new Worker(queueName, async (job: Job) => {
      await this.processJob(job);
    }, { connection: this.redis, concurrency: 5 });

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      logger.error({ err, jobId: job?.id }, 'DomainEventDispatcherWorker job failed');
    });

    this.worker.on('error', err => {
      logger.error({ err }, 'DomainEventDispatcherWorker error');
    });
  }

  private async processJob(job: Job): Promise<void> {
    const { eventId, type, payload } = job.data;
    
    // Safety check for envelope format
    if (!eventId || !type || !payload || typeof payload !== 'object') {
      logger.warn({ jobId: job.id }, 'Invalid event format, skipping broadcast');
      return;
    }

    const typedPayload = payload as Record<string, unknown>;
    const orderId = typedPayload.orderId as string | undefined;

    // 1. Specific routing logic
    if (type === 'ORDER_ACCEPTED' && orderId) {
      try {
        const order = await this.orderService.markOrderPending(orderId);
        this.tradingEngine.addOrder(order);
        logger.info({ orderId }, '[Dispatcher] Routed ORDER_ACCEPTED to PENDING and Engine');
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('Invalid state transition')) {
          // Idempotent recovery: already pending or further along.
          logger.info({ orderId }, '[Dispatcher] Order already processed past ACCEPTED. Silently ignoring duplicate routing.');
        } else {
          throw err;
        }
      }
    } else if (['ORDER_FILLED', 'ORDER_REJECTED', 'ORDER_CANCELLED', 'ORDER_EXPIRED'].includes(type) && orderId) {
      this.tradingEngine.removeOrder(orderId);
    }

    // 2. Broadcast to WebSockets
    const portfolioId = typedPayload.portfolioId as string;
    
    if (portfolioId) {
      const envelope: EventEnvelope = {
        eventId,
        type,
        timestamp: new Date().toISOString(),
        payload: typedPayload
      };

      try {
        this.emitter.to(`portfolio:${portfolioId}`).emit(type, envelope);
        logger.info({ eventId, type, portfolioId }, 'Broadcasted domain event to WebSocket room');
      } catch (error) {
        logger.error({ err: error, eventId }, 'Failed to emit WebSocket event');
        throw error;
      }
    }
  }

  public async close(): Promise<void> {
    await this.worker.close();
    await this.redis.quit();
  }
}
