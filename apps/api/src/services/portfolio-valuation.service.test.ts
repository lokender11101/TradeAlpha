import { PrismaClient, PositionStatus } from '@prisma/client';
import { PriceCacheService } from './price-cache.service';
import { PortfolioValuationService } from './portfolio-valuation.service';
import Redis from 'ioredis';
import * as crypto from 'crypto';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const priceCache = new PriceCacheService(redis);
const valuationService = new PortfolioValuationService(prisma, priceCache);

describe('PortfolioValuationService', () => {
  let userId = '';

  beforeAll(async () => {
    userId = crypto.randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `test-val-${userId}@example.com`,
        passwordHash: 'hash'
      }
    });
  });

  afterAll(async () => {
    await prisma.position.deleteMany({ where: { portfolio: { userId } } });
    await prisma.portfolio.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushall();
    await prisma.position.deleteMany({ where: { portfolio: { userId } } });
    await prisma.portfolio.deleteMany({ where: { userId } });
  });

  it('1. should value a cash-only portfolio', async () => {
    const portfolio = await prisma.portfolio.create({
      data: { userId, totalCash: '10000', lockedCash: '2000' }
    });
    
    const val = await valuationService.getValuation(portfolio.id);
    expect(val.totalCash).toBe('10000.0000');
    expect(val.lockedCash).toBe('2000.0000');
    expect(val.availableCash).toBe('8000.0000');
    expect(val.marketValue).toBe('0.0000');
    expect(val.unrealizedPnl).toBe('0.0000');
    expect(val.realizedPnl).toBe('0.0000');
    expect(val.totalNav).toBe('10000.0000');
    expect(val.isStale).toBe(false);
  });

  it('2. should value a portfolio with one position', async () => {
    const portfolio = await prisma.portfolio.create({
      data: { userId, totalCash: '8000', lockedCash: '0' }
    });
    await prisma.position.create({
      data: {
        portfolioId: portfolio.id,
        symbol: 'AAPL',
        quantity: '10',
        lockedQuantity: '0',
        averageEntryPrice: '150',
        realizedPnl: '0',
        status: PositionStatus.OPEN
      }
    });

    await redis.hset('prices:latest', 'AAPL', JSON.stringify({ price: '160', timestamp: new Date().toISOString() }));

    const val = await valuationService.getValuation(portfolio.id);
    expect(val.totalCash).toBe('8000.0000');
    expect(val.marketValue).toBe('1600.0000'); // 10 * 160
    expect(val.unrealizedPnl).toBe('100.0000'); // 10 * (160 - 150)
    expect(val.totalNav).toBe('9600.0000'); // 8000 + 1600
    expect(val.isStale).toBe(false);
  });

  it('3. should value a portfolio with multiple positions and changing NAV', async () => {
    const portfolio = await prisma.portfolio.create({
      data: { userId, totalCash: '5000', lockedCash: '0' }
    });
    await prisma.position.create({
      data: {
        portfolioId: portfolio.id,
        symbol: 'AAPL',
        quantity: '10',
        lockedQuantity: '0',
        averageEntryPrice: '150',
        realizedPnl: '50',
        status: PositionStatus.OPEN
      }
    });
    await prisma.position.create({
      data: {
        portfolioId: portfolio.id,
        symbol: 'TSLA',
        quantity: '5',
        lockedQuantity: '0',
        averageEntryPrice: '200',
        realizedPnl: '-20',
        status: PositionStatus.OPEN
      }
    });

    await redis.hset('prices:latest', 'AAPL', JSON.stringify({ price: '140', timestamp: new Date().toISOString() }));
    await redis.hset('prices:latest', 'TSLA', JSON.stringify({ price: '210', timestamp: new Date().toISOString() }));

    const val = await valuationService.getValuation(portfolio.id);
    expect(val.marketValue).toBe('2450.0000');
    expect(val.unrealizedPnl).toBe('-50.0000');
    expect(val.realizedPnl).toBe('30.0000');
    expect(val.totalNav).toBe('7450.0000'); // 5000 + 2450
  });

  it('4. should handle zero position quantity', async () => {
    const portfolio = await prisma.portfolio.create({
      data: { userId, totalCash: '10000', lockedCash: '0' }
    });
    await prisma.position.create({
      data: {
        portfolioId: portfolio.id,
        symbol: 'AAPL',
        quantity: '0',
        lockedQuantity: '0',
        averageEntryPrice: '150',
        realizedPnl: '500',
        status: PositionStatus.CLOSED
      }
    });

    const val = await valuationService.getValuation(portfolio.id);
    expect(val.marketValue).toBe('0.0000');
    expect(val.unrealizedPnl).toBe('0.0000');
    expect(val.realizedPnl).toBe('500.0000');
    expect(val.totalNav).toBe('10000.0000');
  });

  it('5. should handle stale price behavior', async () => {
    const portfolio = await prisma.portfolio.create({
      data: { userId, totalCash: '8000', lockedCash: '0' }
    });
    await prisma.position.create({
      data: {
        portfolioId: portfolio.id,
        symbol: 'AAPL',
        quantity: '10',
        lockedQuantity: '0',
        averageEntryPrice: '150',
        realizedPnl: '0',
        status: PositionStatus.OPEN
      }
    });

    // We do NOT set price in redis to trigger stale.
    const val = await valuationService.getValuation(portfolio.id);
    expect(val.isStale).toBe(true);
    expect(val.marketValue).toBe('1500.0000'); // 10 * 150
    expect(val.unrealizedPnl).toBe('0.0000');
    expect(val.totalNav).toBe('9500.0000');
  });
});
