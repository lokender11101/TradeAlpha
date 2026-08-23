import { PrismaClient, Prisma } from '@prisma/client';
import { OhlcvAggregatorWorker } from './workers/ohlcv-aggregator.worker';
import { defaultTimeProvider } from './services/time.provider';
import { defaultMarketSessionService } from './services/market-session.service';
import { MarketCandleService } from './services/market-candle.service';
import Redis from 'ioredis';
import crypto from 'crypto';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

describe('OHLCV Aggregator & Market Candle E2E', () => {
  let prisma: PrismaClient;
  let worker1: OhlcvAggregatorWorker;
  let worker2: OhlcvAggregatorWorker;
  let publisher: Redis;
  let subscriber: Redis;
  let candleService: MarketCandleService;
  
  beforeAll(async () => {
    prisma = new PrismaClient();
    worker1 = new OhlcvAggregatorWorker(prisma, redisUrl);
    worker2 = new OhlcvAggregatorWorker(prisma, redisUrl); // For concurrency testing
    publisher = new Redis(redisUrl);
    subscriber = new Redis(redisUrl);
    candleService = new MarketCandleService(prisma);
    
    await worker1.start();
    await worker2.start();
  });

  afterAll(async () => {
    await worker1.stop();
    await worker2.stop();
    await publisher.quit();
    await subscriber.quit();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.marketCandle.deleteMany({});
    await prisma.marketTickReceipt.deleteMany({});
  });

  const pushTickAndWait = async (symbol: string, price: string, volume: string, timestamp: Date, tickId?: string) => {
    const tId = tickId || crypto.randomUUID();
    const payload = JSON.stringify({
      tickId: tId,
      symbol,
      price,
      volume,
      timestamp: timestamp.toISOString()
    });
    
    await publisher.publish(`market:tick:${symbol}`, payload);
    // Wait for worker processing
    await new Promise(resolve => setTimeout(resolve, 100));
    return tId;
  };

  it('1. first tick creates candle', async () => {
    const timestamp = new Date('2026-08-24T10:00:05.000+05:30'); // Open market
    
    await pushTickAndWait('AAPL', '150.00', '100', timestamp);
    
    const candles = await prisma.marketCandle.findMany({ where: { symbol: 'AAPL' } });
    expect(candles).toHaveLength(1);
    expect(candles[0].open.toString()).toBe('150');
    expect(candles[0].high.toString()).toBe('150');
    expect(candles[0].low.toString()).toBe('150');
    expect(candles[0].close.toString()).toBe('150');
    expect(candles[0].volume.toString()).toBe('100');
    expect(candles[0].isClosed).toBe(false);
  });

  it('2-5. high/low/close and volume accumulation', async () => {
    const t1 = new Date('2026-08-24T10:00:05.000+05:30');
    const t2 = new Date('2026-08-24T10:00:15.000+05:30');
    const t3 = new Date('2026-08-24T10:00:25.000+05:30');
    const t4 = new Date('2026-08-24T10:00:35.000+05:30');
    
    await pushTickAndWait('AAPL', '150.00', '100', t1); // Open
    await pushTickAndWait('AAPL', '155.00', '200', t2); // High
    await pushTickAndWait('AAPL', '145.00', '300', t3); // Low
    await pushTickAndWait('AAPL', '152.00', '400', t4); // Close

    const candles = await prisma.marketCandle.findMany({ where: { symbol: 'AAPL' } });
    expect(candles).toHaveLength(1);
    expect(candles[0].open.toString()).toBe('150');
    expect(candles[0].high.toString()).toBe('155');
    expect(candles[0].low.toString()).toBe('145');
    expect(candles[0].close.toString()).toBe('152');
    expect(candles[0].volume.toString()).toBe('1000');
  });

  it('6-8. duplicate tick handling and concurrent upserts (idempotency)', async () => {
    const timestamp = new Date('2026-08-24T10:00:05.000+05:30');
    const tickId = crypto.randomUUID();
    
    // Push same logical tick multiple times rapidly to simulate concurrent worker receipt
    await Promise.all([
      pushTickAndWait('AAPL', '150.00', '100', timestamp, tickId),
      pushTickAndWait('AAPL', '150.00', '100', timestamp, tickId),
      pushTickAndWait('AAPL', '150.00', '100', timestamp, tickId),
    ]);

    const candles = await prisma.marketCandle.findMany({ where: { symbol: 'AAPL' } });
    expect(candles).toHaveLength(1);
    expect(candles[0].volume.toString()).toBe('100'); // Volume must NOT be 300
    
    const receipts = await prisma.marketTickReceipt.findMany();
    expect(receipts).toHaveLength(1); // Only 1 receipt
  });

  it('9,11. candle boundary transition and closed modification check', async () => {
    const t1 = new Date('2026-08-24T10:00:30.000+05:30');
    const t2 = new Date('2026-08-24T10:01:10.000+05:30'); // Next minute
    
    await pushTickAndWait('AAPL', '150.00', '100', t1);
    
    let candles = await prisma.marketCandle.findMany({ where: { symbol: 'AAPL' }, orderBy: { timestamp: 'asc' } });
    expect(candles).toHaveLength(1);
    expect(candles[0].isClosed).toBe(false);

    // Push tick for next minute, this should close the first candle
    await pushTickAndWait('AAPL', '152.00', '200', t2);
    
    candles = await prisma.marketCandle.findMany({ where: { symbol: 'AAPL' }, orderBy: { timestamp: 'asc' } });
    expect(candles).toHaveLength(2);
    expect(candles[0].isClosed).toBe(true);
    expect(candles[1].isClosed).toBe(false);

    // Out-of-order older tick for previous minute (simulating delayed delivery of an EARLIER tick)
    const tLate = new Date('2026-08-24T10:00:15.000+05:30');
    await pushTickAndWait('AAPL', '160.00', '50', tLate);

    // It should STILL update the closed candle's High, but NOT change its close, and NOT reopen it
    candles = await prisma.marketCandle.findMany({ where: { symbol: 'AAPL', timestamp: new Date('2026-08-24T10:00:00.000+05:30') } });
    expect(candles[0].high.toString()).toBe('160');
    expect(candles[0].close.toString()).toBe('150'); // unchanged
    expect(candles[0].isClosed).toBe(true); // remains closed
  });

  it('12. ticks outside market hours are ignored', async () => {
    const t1 = new Date('2026-08-24T09:00:00.000+05:30'); // Before 9:15
    await pushTickAndWait('AAPL', '150.00', '100', t1);
    
    const candles = await prisma.marketCandle.findMany({ where: { symbol: 'AAPL' } });
    expect(candles).toHaveLength(0); // Ignored
  });

  it('13-16. higher timeframe derivations', async () => {
    // Generate 10 consecutive 1m candles
    for (let i = 0; i < 10; i++) {
      const t = new Date(`2026-08-24T09:${15 + i}:30.000+05:30`);
      await pushTickAndWait('RELIANCE', (2000 + i).toString(), '100', t);
    }
    
    // Fetch 5m candles
    const fiveMin = await candleService.getCandles('RELIANCE', '5m', 10);
    expect(fiveMin).toHaveLength(2); // 9:15-9:20 and 9:20-9:25
    expect(fiveMin[0].volume).toBe('500'); // 100 * 5
    expect(fiveMin[1].volume).toBe('500');
    
    // Fetch 15m candles
    const fifteenMin = await candleService.getCandles('RELIANCE', '15m', 10);
    expect(fifteenMin).toHaveLength(1);
    expect(fifteenMin[0].volume).toBe('1000');
    
    // Fetch 1d candles
    const oneDay = await candleService.getCandles('RELIANCE', '1d', 10);
    expect(oneDay).toHaveLength(1);
    expect(oneDay[0].volume).toBe('1000');
    expect(oneDay[0].timestamp).toBe(new Date('2026-08-24T09:15:00.000+05:30').toISOString());
  });
});
