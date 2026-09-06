import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
});

const prisma = new PrismaClient();

export class WebhookWorker {
  private readonly worker: Worker;
  private readonly redis: Redis;

  constructor(redisUrl: string, queueName: string = 'tradealpha-webhooks') {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    
    this.worker = new Worker(queueName, async (job: Job) => {
      await this.processJob(job);
    }, { 
      connection: this.redis, 
      concurrency: 5,
      // Bounded retries with exponential backoff (configured at enqueue time)
    });

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      logger.error({ err, jobId: job?.id }, 'WebhookWorker job failed');
    });
  }

  private async processJob(job: Job): Promise<void> {
    const { webhookId, payload, eventId } = job.data;
    
    const webhook = await prisma.webhookSubscription.findUnique({ where: { id: webhookId } });
    if (!webhook || !webhook.active) {
      logger.info({ webhookId, eventId }, 'Webhook inactive or deleted, skipping');
      return;
    }

    const payloadStr = JSON.stringify(payload);
    
    // Cryptographic payload signing
    const signature = crypto
      .createHmac('sha256', webhook.secret)
      .update(payloadStr)
      .digest('hex');

    logger.info({ webhookId, eventId, url: webhook.url }, 'Dispatching webhook');
    
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-TradeAlpha-Event': payload.type || 'UNKNOWN'
        },
        body: payloadStr,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Webhook delivered but returned HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }

  }

  public async close(): Promise<void> {
    await this.worker.close();
    await this.redis.quit();
  }
}
