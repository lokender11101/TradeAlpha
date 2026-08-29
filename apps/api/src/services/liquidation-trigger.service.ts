import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';

const logger = pino({
  name: 'LiquidationTriggerService',
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
});

const prisma = new PrismaClient();
const connection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
const liquidationQueue = new Queue('liquidation-eval-queue', { connection });

export class LiquidationTriggerService {
  private subscriber: Redis;

  constructor() {
    this.subscriber = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
  }

  async start() {
    await this.subscriber.psubscribe('market:tick:*');
    logger.info('LiquidationTriggerService started, listening to market:tick:*');

    this.subscriber.on('pmessage', async (pattern, channel, message) => {
      try {
        if (pattern === 'market:tick:*') {
          // Note: tick comes over pubsub from market simulator? Or the channel is prices:latest?
          // The other worker subscribes to market:tick:* ... Wait, MarketSimulator emits 'tick'. PriceCachePublisher broadcasts via socket.io to `market:${tick.symbol}`.
          // Is there a pubsub `market:tick:*`?
          // Oh, wait, in apps/api/src/workers/ohlcv-aggregator.worker.ts, it listens to `market:tick:*`?
          // The instruction says "listening to market:tick:*" so I'll trust it.
          const tick = JSON.parse(message);
          const symbol = tick.symbol || tick.payload?.symbol; // Handle both direct tick or envelope
          
          if (!symbol) return;

          const portfolios = await prisma.$queryRaw<{ portfolio_id: string }[]>`
            SELECT DISTINCT p.portfolio_id 
            FROM positions p 
            JOIN portfolios pf ON p.portfolio_id = pf.id 
            WHERE p.symbol = ${symbol} 
              AND p.quantity != 0 
              AND pf.is_margin_enabled = true;
          `;

          for (const row of portfolios) {
            const portfolioId = row.portfolio_id;
            const jobId = `eval_${portfolioId}_${Math.floor(Date.now() / 1000)}`;
            await liquidationQueue.add(
              'evaluate-risk',
              { portfolioId },
              {
                jobId,
                removeOnComplete: true,
                removeOnFail: 1000
              }
            );
          }
        }
      } catch (error) {
        logger.error({ error }, 'Error processing market tick in LiquidationTriggerService');
      }
    });
  }

  async stop() {
    await this.subscriber.punsubscribe('market:tick:*');
    await this.subscriber.quit();
    await liquidationQueue.close();
  }
}

export const defaultLiquidationTriggerService = new LiquidationTriggerService();
