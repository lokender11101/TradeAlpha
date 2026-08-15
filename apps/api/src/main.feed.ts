import dotenv from 'dotenv';
import pino from 'pino';
import Redis from 'ioredis';
import * as crypto from 'crypto';
import { MarketSimulatorService } from './services/market-simulator.service';
import { PriceCachePublisher } from './services/price-cache.service';
import { MarketDataPublisher } from './services/market-data-publisher';
import { defaultMarketSessionService } from './services/market-session.service';

dotenv.config();

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname'
    }
  }
});

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

class FeedLeaseService {
  private readonly redis: Redis;
  private readonly processToken: string;
  private readonly simulator: MarketSimulatorService;
  private heartbeatInterval?: NodeJS.Timeout;
  private isOwned: boolean = false;
  // @ts-ignore
  private priceCachePublisher: PriceCachePublisher;
  // @ts-ignore
  private marketDataPublisher: MarketDataPublisher;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.processToken = crypto.randomUUID();
    this.simulator = new MarketSimulatorService();
    this.priceCachePublisher = new PriceCachePublisher(this.redis, this.simulator);
    this.marketDataPublisher = new MarketDataPublisher(this.redis, this.simulator);
  }

  public async start(): Promise<void> {
    logger.info('[FeedLeaseService] Starting lease acquisition loop for feed:global...');
    // Initial attempt
    await this.tryAcquireLease();
    
    // Continuous heartbeat/acquisition loop
    this.heartbeatInterval = setInterval(() => this.heartbeat(), 10000);
  }

  private async tryAcquireLease(): Promise<void> {
    try {
      const acquired = await this.redis.set('feed:global', this.processToken, 'EX', 15, 'NX');
      
      if (acquired) {
        if (!this.isOwned) {
          logger.info('[FeedLeaseService] Acquired feed:global lease. Starting simulator...');
          this.isOwned = true;
          this.startSimulations();
        }
      }
    } catch (err) {
      logger.error({ err }, '[FeedLeaseService] Failed to acquire lease');
    }
  }

  private async heartbeat(): Promise<void> {
    if (!this.isOwned) {
      if (defaultMarketSessionService.isOpen()) {
        await this.tryAcquireLease();
      }
      return;
    }

    if (!defaultMarketSessionService.isOpen()) {
      logger.info('[FeedLeaseService] Market session CLOSED. Releasing lease and stopping simulations.');
      this.isOwned = false;
      this.stopSimulations();
      await this.redis.eval(LUA_RELEASE, 1, 'feed:global', this.processToken);
      return;
    }

    try {
      const result = await this.redis.eval(LUA_HEARTBEAT, 1, 'feed:global', this.processToken);
      if (result === 1) {
        logger.debug('[FeedLeaseService] Heartbeat successful');
      } else {
        logger.warn('[FeedLeaseService] Lost feed:global lease during heartbeat. Stopping simulator...');
        this.isOwned = false;
        this.stopSimulations();
      }
    } catch (err) {
      logger.error({ err }, '[FeedLeaseService] Heartbeat failed');
      this.isOwned = false;
      this.stopSimulations();
    }
  }

  private startSimulations(): void {
    if (!defaultMarketSessionService.isOpen()) {
      logger.info('[FeedLeaseService] Market is CLOSED. Not starting simulations.');
      return;
    }
    const symbols = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK'];
    symbols.forEach(symbol => {
      this.simulator.startSimulation({
        symbol,
        initialPrice: 150.0, // Default mock start
        volatility: 0.005,
        intervalMs: 2000
      });
    });
    logger.info({ symbols }, '[FeedLeaseService] Started simulations');
  }

  private stopSimulations(): void {
    const symbols = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK'];
    symbols.forEach(symbol => {
      this.simulator.stopSimulation(symbol);
    });
    logger.info('[FeedLeaseService] Stopped all simulations');
  }

  public async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.stopSimulations();
    if (this.isOwned) {
      await this.redis.eval(LUA_RELEASE, 1, 'feed:global', this.processToken);
    }
    await this.redis.quit();
  }
}

export { FeedLeaseService };

if (process.env.NODE_ENV !== 'test') {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const feedService = new FeedLeaseService(redisUrl);

  feedService.start().catch(err => {
    logger.error({ err }, 'Failed to start FeedLeaseService');
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down FeedLeaseService...');
    await feedService.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    logger.info('Shutting down FeedLeaseService...');
    await feedService.stop();
    process.exit(0);
  });
}
