import { PrismaClient, OutboxEvent } from '@prisma/client';
import { Queue } from 'bullmq';
import pino from 'pino';
import Redis from 'ioredis';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, ignore: 'pid,hostname' }
  }
});

export class OutboxWorker {
  private readonly prisma: PrismaClient;
  private readonly queue: Queue;
  private readonly redis: Redis;
  private isRunning: boolean = false;
  private intervalId?: NodeJS.Timeout;

  public readonly MAX_RETRIES = 5;
  public readonly BATCH_SIZE = 50;

  constructor(prisma: PrismaClient, redisUrl: string, queueName: string = 'tradealpha-domain-events') {
    this.prisma = prisma;
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(queueName, { connection: this.redis });
  }

  public async start(pollIntervalMs: number = 2000): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('OutboxWorker started');
    
    const tick = async () => {
      if (!this.isRunning) return;
      try {
        await this.processOutbox();
      } catch (error) {
        logger.error({ err: error }, 'Error in OutboxWorker loop');
      } finally {
        if (this.isRunning) {
          this.intervalId = setTimeout(tick, pollIntervalMs);
        }
      }
    };
    
    tick();
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.intervalId) {
      clearTimeout(this.intervalId);
    }
    await this.queue.close();
    await this.redis.quit();
    logger.info('OutboxWorker stopped');
  }

  /**
   * Public for testing. Normally invoked by the polling loop.
   */
  public async processOutbox(): Promise<number> {
    return await this.prisma.$transaction(async (tx) => {
      // 1. Claim pending or retryable events atomically
      const events = await tx.$queryRaw<OutboxEvent[]>`
        SELECT * FROM outbox_events 
        WHERE status = 'PENDING' 
           OR (status = 'FAILED' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW())
        ORDER BY created_at ASC
        LIMIT ${this.BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `;

      if (!events || events.length === 0) return 0;

      let processedCount = 0;

      for (const event of events) {
        try {
          // 2. Publish to BullMQ
          // Use event.id as deterministic jobId to avoid duplicate processing in BullMQ
          await this.queue.add(
            event.type,
            {
              eventId: event.id,
              type: event.type,
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              payload: event.payload
            },
            {
              jobId: event.id,
              attempts: 3,
              backoff: { type: 'exponential', delay: 1000 }
            }
          );

          // 3. Mark as PUBLISHED
          await tx.$executeRaw`
            UPDATE outbox_events 
            SET status = 'PUBLISHED'::"EventStatus", published_at = NOW(), error = NULL
            WHERE id = ${event.id}
          `;

          logger.info({ eventId: event.id, eventType: event.type, aggregateId: event.aggregateId }, 'Event published successfully');
          processedCount++;
        } catch (error: unknown) {
          const attempts = event.attempts + 1;
          const isPermanentlyFailed = attempts >= this.MAX_RETRIES;
          
          let nextRetryAt = null;
          if (!isPermanentlyFailed) {
            // Exponential backoff: 2^attempts seconds
            const delayMs = Math.pow(2, attempts) * 1000;
            nextRetryAt = new Date(Date.now() + delayMs);
          }

          // 4. Mark as FAILED
          await tx.$executeRaw`
            UPDATE outbox_events 
            SET status = 'FAILED'::"EventStatus", attempts = ${attempts}, next_retry_at = ${nextRetryAt}, error = ${error instanceof Error ? error.message : 'Unknown error'}
            WHERE id = ${event.id}
          `;

          if (isPermanentlyFailed) {
            logger.error({ eventId: event.id, eventType: event.type, attempts }, 'Event permanently failed');
          } else {
            logger.warn({ eventId: event.id, attempts, nextRetryAt }, 'Event publish failed, scheduled for retry');
          }
        }
      }

      return processedCount;
    });
  }
}
