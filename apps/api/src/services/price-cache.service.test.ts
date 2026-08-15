import Redis from 'ioredis';
import { PriceCacheService, PriceCachePublisher } from './price-cache.service';
import { MarketSimulatorService, MarketTick } from './market-simulator.service';
import { defaultTimeProvider } from './time.provider';

describe('PriceCacheService & PriceCachePublisher', () => {
  let redis: Redis;
  let cacheService: PriceCacheService;
  let publisher: PriceCachePublisher;
  let simulator: MarketSimulatorService;

  beforeAll(() => {
    // Relying on default localhost redis which the repo's test infra supports
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
    
    // Set a very short threshold for boundary testing
    process.env.STALE_PRICE_THRESHOLD_MS = '100'; 
    cacheService = new PriceCacheService(redis);
    
    simulator = new MarketSimulatorService();
    publisher = new PriceCachePublisher(redis, simulator);
  });

  beforeEach(async () => {
    await redis.del('prices:latest');
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('should publish a MarketTick and retrieve it successfully', async () => {
    // Simulator emits tick
    simulator.pushTick('AAPL', 150.1234);

    // Wait a brief moment for Redis HSET to complete (async event)
    await new Promise(r => setTimeout(r, 10));

    const result = await cacheService.getLatestPrice('AAPL');
    expect(result.isStale).toBe(false);
    expect(result.price).toBe('150.1234');
    expect(result.updatedAt).toBeInstanceOf(Date);
  });

  it('should return isStale = true if the price exceeds STALE_PRICE_THRESHOLD_MS', async () => {
    const tick: MarketTick = {
      symbol: 'MSFT',
      price: '250.00',
      // Explicitly set an old timestamp (15 seconds ago) based on the current time provider
      timestamp: new Date(defaultTimeProvider.now().getTime() - 15000)
    };
    await cacheService.publishTick(tick);

    const result = await cacheService.getLatestPrice('MSFT');
    expect(result.isStale).toBe(true);
    // Even if stale, it should return the last known price/date for UI display
    expect(result.price).toBe('250.00');
    expect(result.updatedAt?.getTime()).toBe(tick.timestamp.getTime());
  });

  it('should handle Redis unavailable/error behavior gracefully', async () => {
    const errorRedis = new Redis('redis://invalid-host:9999', {
      maxRetriesPerRequest: 0,
      retryStrategy: () => null // Fail immediately
    });
    
    // Suppress unhandled errors during connection
    errorRedis.on('error', () => {}); 

    const badCacheService = new PriceCacheService(errorRedis);

    const result = await badCacheService.getLatestPrice('AAPL');
    expect(result.isStale).toBe(true);
    expect(result.price).toBeNull();
    expect(result.updatedAt).toBeNull();

    errorRedis.disconnect();
  });
});
