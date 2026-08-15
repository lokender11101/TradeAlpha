import { Redis } from 'ioredis';
import { MarketSimulatorService, MarketTick } from './market-simulator.service';
import { Emitter } from '@socket.io/redis-emitter';
import pino from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, ignore: 'pid,hostname' }
  }
});

import { defaultTimeProvider } from './time.provider';

export class PriceCacheService {
  private redis: Redis;
  private readonly STALE_THRESHOLD_MS: number;

  constructor(redis: Redis) {
    this.redis = redis;
    // Default to 10 seconds if not configured
    this.STALE_THRESHOLD_MS = parseInt(process.env.STALE_PRICE_THRESHOLD_MS || '10000', 10);
  }

  /**
   * Publishes the latest market tick to the Redis hash 'prices:latest'.
   * The value is serialized as a JSON object containing the price and the exact timestamp.
   */
  async publishTick(tick: MarketTick): Promise<void> {
    const payload = JSON.stringify({
      price: tick.price,
      timestamp: tick.timestamp.toISOString()
    });
    
    // We use HSET to store all symbols in a single hash, allowing easy retrieval of specific symbols.
    await this.redis.hset('prices:latest', tick.symbol, payload);
  }

  /**
   * Retrieves the latest price for a symbol from the Redis cache.
   * If the price is older than STALE_PRICE_THRESHOLD_MS or Redis is unavailable/errors, it returns stale.
   */
  async getLatestPrice(symbol: string): Promise<{ price: string | null, isStale: boolean, updatedAt: Date | null }> {
    try {
      const data = await this.redis.hget('prices:latest', symbol);
      if (!data) {
        return { price: null, isStale: true, updatedAt: null };
      }

      const parsed = JSON.parse(data);
      const updatedAt = new Date(parsed.timestamp);
      const now = defaultTimeProvider.now().getTime();

      if (now - updatedAt.getTime() > this.STALE_THRESHOLD_MS) {
        return { price: parsed.price, isStale: true, updatedAt };
      }

      return { price: parsed.price, isStale: false, updatedAt };
    } catch (_error) {
      return { price: null, isStale: true, updatedAt: null };
    }
  }
}

export class PriceCachePublisher {
  private emitter: Emitter;

  constructor(private redis: Redis, private simulator: MarketSimulatorService) {
    this.emitter = new Emitter(this.redis);
    this.simulator.on('tick', this.handleTick.bind(this));
  }

  private async handleTick(tick: MarketTick): Promise<void> {
    const payload = JSON.stringify({
      price: tick.price,
      timestamp: tick.timestamp.toISOString()
    });
    
    // Separate try-catch blocks to isolate failure domains
    try {
      await this.redis.hset('prices:latest', tick.symbol, payload);
    } catch (error) {
      logger.error({ err: error, symbol: tick.symbol }, 'Failed to persist MarketTick to Redis Cache');
    }

    try {
      this.emitter.to(`market:${tick.symbol}`).emit('MARKET_TICK', {
        eventId: `tick-${tick.symbol}-${tick.timestamp.getTime()}`,
        type: 'MARKET_TICK',
        timestamp: tick.timestamp.toISOString(),
        payload: {
          symbol: tick.symbol,
          price: tick.price
        }
      });
    } catch (error) {
      logger.error({ err: error, symbol: tick.symbol }, 'Failed to broadcast MarketTick via WebSocket');
    }
  }
}
