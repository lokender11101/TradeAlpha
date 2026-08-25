import { PrismaClient } from '@prisma/client';
import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { OrderService } from '../services/order.service';
import { runInTrace } from '../utils/telemetry-utils';
import { SpanKind } from '@opentelemetry/api';
import { defaultMarketSessionService } from '../services/market-session.service';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, ignore: 'pid,hostname' }
  }
});

export interface ExecuteFillJob {
  orderId: string;
  price: string;
  quantity: string;
  executionIdempotencyKey: string;
  correlationId?: string;
  originTimestamp?: string;
  metadata?: Record<string, string>;
}

export class ExecutionWorker {
  private readonly worker: Worker;
  private readonly redis: Redis;
  private readonly orderService: OrderService;

  constructor(
    private readonly prisma: PrismaClient,
    redisUrl: string,
    queueName: string = 'tradealpha-execution'
  ) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.orderService = new OrderService(this.prisma);

    this.worker = new Worker(
      queueName,
      async (job: Job<ExecuteFillJob>) => {
        return this.processJob(job);
      },
      { connection: this.redis, concurrency: 5 }
    );

    this.worker.on('completed', (job) => {
      logger.info({ jobId: job.id, orderId: job.data.orderId }, 'ExecuteFill job completed idempotently');
    });

    this.worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, err }, 'ExecuteFill job failed');
    });
  }

  public async close(): Promise<void> {
    await this.worker.close();
    await this.redis.quit();
  }

  private async processJob(job: Job<ExecuteFillJob>): Promise<void> {
    return runInTrace('ExecutionWorker EXECUTE_FILL', job.data.metadata || {}, SpanKind.CONSUMER, async () => {
    const { orderId, price, quantity, executionIdempotencyKey, correlationId, originTimestamp } = job.data;
    logger.info({ orderId, price, quantity, executionIdempotencyKey, correlationId: correlationId || 'system' }, 'Processing EXECUTE_FILL job');

    if (originTimestamp) {
      const originDate = new Date(originTimestamp);
      const originState = defaultMarketSessionService.getSessionOriginState(originDate);
      if (originState === 'CLOSED') {
        logger.warn({ orderId, originTimestamp }, 'EXECUTE_FILL rejected: Origin timestamp belongs to a CLOSED market session');
        return;
      }
    } else {
      // For backwards compatibility or missing timestamps
      if (!defaultMarketSessionService.isOpen()) {
        logger.warn({ orderId }, 'EXECUTE_FILL rejected: Market is closed and no origin timestamp was provided');
        return;
      }
    }

    try {
      // Delegate to OrderService which handles the strictly idempotent transaction
      // It also verifies if the order is still executable (not EXPIRED, CANCELLED, or already FILLED)
      // Because processFill locks the order and verifies its state.
      await this.orderService.processFill({
        orderId,
        price,
        quantity,
        fillIdempotencyKey: executionIdempotencyKey
      });
    } catch (err: any) {
      if (err instanceof Error && err.message.includes('Invalid state transition')) {
        // If order was expired by EOD sweep, processFill will throw invalid state transition.
        // We catch it and warn, ignoring the stale fill.
        logger.warn({ orderId, err: err.message }, 'EXECUTE_FILL stale: Order is no longer executable');
        return;
      }
      if (err && (err.code === 'P2025' || (err.message && err.message.toLowerCase().includes('not found')))) {
        logger.warn({ orderId, err: err.message }, 'EXECUTE_FILL stale: Order was deleted or not found');
        return;
      }
      throw err;
    }
    });
  }
}
