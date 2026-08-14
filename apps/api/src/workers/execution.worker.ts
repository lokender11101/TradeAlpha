import { PrismaClient } from '@prisma/client';
import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { OrderService } from '../services/order.service';

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
    const { orderId, price, quantity, executionIdempotencyKey, correlationId } = job.data;
    logger.info({ orderId, price, quantity, executionIdempotencyKey, correlationId: correlationId || 'system' }, 'Processing EXECUTE_FILL job');

    // Delegate to OrderService which handles the strictly idempotent transaction
    await this.orderService.processFill({
      orderId,
      price,
      quantity,
      fillIdempotencyKey: executionIdempotencyKey
    });
  }
}
