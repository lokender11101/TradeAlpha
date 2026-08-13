import { Worker, Job } from 'bullmq';
import { Emitter } from '@socket.io/redis-emitter';
import Redis from 'ioredis';
import pino from 'pino';
import { EventEnvelope } from '../websocket';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, ignore: 'pid,hostname' }
  }
});

export class EventBroadcasterWorker {
  private readonly worker: Worker;
  private readonly redis: Redis;
  private readonly emitter: Emitter;

  constructor(redisUrl: string, queueName: string = 'tradealpha-domain-events') {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.emitter = new Emitter(this.redis);

    this.worker = new Worker(queueName, async (job: Job) => {
      await this.processJob(job);
    }, { connection: this.redis, concurrency: 5 });

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      logger.error({ err, jobId: job?.id }, 'EventBroadcasterWorker job failed');
    });

    this.worker.on('error', err => {
      logger.error({ err }, 'EventBroadcasterWorker error');
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
    
    // Determine the room based on the event payload. 
    // Most domain events in TradeAlpha belong to a portfolio.
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
        // Emitter failure should crash the job to allow BullMQ to retry (at-least-once guarantee)
        logger.error({ err: error, eventId }, 'Failed to emit WebSocket event');
        throw error;
      }
    } else {
      logger.debug({ eventId, type }, 'Event has no portfolioId, skipping WebSocket broadcast');
    }
  }

  public async close(): Promise<void> {
    await this.worker.close();
    await this.redis.quit();
  }
}
