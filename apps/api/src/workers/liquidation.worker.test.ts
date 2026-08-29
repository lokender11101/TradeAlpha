import { PrismaClient, OrderSide, OrderStatus, OrderType } from '@prisma/client';
import { LiquidationWorker } from './liquidation.worker';
import { defaultMarketSessionService } from '../services/market-session.service';
import Redis from 'ioredis';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

describe('LiquidationWorker', () => {
  let worker: LiquidationWorker;
  let userId: string;
  let portfolioId: string;

  beforeAll(async () => {
    // Start market session for testing
    jest.spyOn(defaultMarketSessionService, 'isOpen').mockReturnValue(true);

    const user = await prisma.user.create({
      data: {
        email: `liq_test_${Date.now()}@example.com`,
        passwordHash: 'hash',
        
      }
    });
    userId = user.id;

    const pf = await prisma.portfolio.create({
      data: {
        userId,
        totalCash: 1000,
        lockedCash: 0,
        
        isMarginEnabled: true,
      }
    });
    portfolioId = pf.id;

    // Seed price
    await redis.hset('prices:latest', 'AAPL', JSON.stringify({ price: '100', timestamp: new Date().toISOString() }));
    await redis.hset('prices:latest', 'TSLA', JSON.stringify({ price: '200', timestamp: new Date().toISOString() }));
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { portfolioId } });
    await prisma.position.deleteMany({ where: { portfolioId } });
    await prisma.portfolio.delete({ where: { id: portfolioId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
    await redis.quit();
  });

  beforeEach(() => {
    worker = new LiquidationWorker();
  });

  afterEach(async () => {
    await worker.close();
    await prisma.order.deleteMany({ where: { portfolioId } });
    await prisma.position.deleteMany({ where: { portfolioId } });
    await prisma.portfolio.update({
      where: { id: portfolioId },
      data: { totalCash: 1000 }
    });
  });

  it('should ignore portfolio if margin > 120%', async () => {
    // 100 AAPL @ $100 = $10,000 value. IM = 50% = 5000. Cash = 10000. Equity = 20000. Margin Level = 20000 / 5000 = 400%.
    await prisma.portfolio.update({ where: { id: portfolioId }, data: { totalCash: 10000 } });
    await prisma.position.create({
      data: { portfolioId, symbol: 'AAPL', quantity: 100, averageEntryPrice: 100, status: 'OPEN' }
    });

    await (worker as any).evaluatePortfolio(portfolioId);

    const orders = await prisma.order.findMany({ where: { portfolioId } });
    expect(orders.length).toBe(0);
  });

  it('should ignore portfolio if margin is exactly 100% (MARGIN_CALL but not FORCED)', async () => {
    // Cash = 0, Position = 100 AAPL @ 100 = 10,000. Equity = 10,000. IM = 5,000. MM = 2,500. MarginLevel = 200%.
    // To make margin level exactly 100%: Equity must equal MM.
    // Equity = 2,500. Position = 10,000. So Cash = -7,500.
    await prisma.portfolio.update({ where: { id: portfolioId }, data: { totalCash: -7400 } });
    await prisma.position.create({
      data: { portfolioId, symbol: 'AAPL', quantity: 100, averageEntryPrice: 100, status: 'OPEN' }
    });

    await (worker as any).evaluatePortfolio(portfolioId);
    const orders = await prisma.order.findMany({ where: { portfolioId } });
    expect(orders.length).toBe(0);
  });

  it('should liquidate if margin < 100%', async () => {
    // To make margin level < 100%: Equity must be < MM.
    // Let's set Cash = -8,000. Equity = 2,000. MM = 2,500. Margin Level = 80%.
    await prisma.portfolio.update({ where: { id: portfolioId }, data: { totalCash: -8000 } });
    await prisma.position.create({
      data: { portfolioId, symbol: 'AAPL', quantity: 100, averageEntryPrice: 100, status: 'OPEN' }
    });

    await (worker as any).evaluatePortfolio(portfolioId);
    
    const orders = await prisma.order.findMany({ where: { portfolioId } });
    expect(orders.length).toBe(1);
    expect(orders[0].symbol).toBe('AAPL');
    expect(orders[0].side).toBe('SELL');
    expect(orders[0].isLiquidation).toBe(true);
    expect(Number(orders[0].requestedQuantity)).toBe(100);
    expect(orders[0].idempotencyKey).toMatch(/^liq_.*_round_0$/);
  });

  it('should not create duplicate liquidation orders if one is already active', async () => {
    await prisma.portfolio.update({ where: { id: portfolioId }, data: { totalCash: -8000 } });
    await prisma.position.create({
      data: { portfolioId, symbol: 'AAPL', quantity: 100, averageEntryPrice: 100, status: 'OPEN' }
    });

    await (worker as any).evaluatePortfolio(portfolioId);
    await (worker as any).evaluatePortfolio(portfolioId); // second time should skip

    const orders = await prisma.order.findMany({ where: { portfolioId } });
    expect(orders.length).toBe(1);
  });

  it('should cancel active liquidation orders if margin recovers above 120%', async () => {
    // 1. Create a position and a pending liquidation order manually
    await prisma.portfolio.update({ where: { id: portfolioId }, data: { totalCash: 10000 } });
    await prisma.position.create({
      data: { portfolioId, symbol: 'AAPL', quantity: 100, averageEntryPrice: 100, status: 'OPEN' }
    });
    
    await prisma.order.create({
      data: {
        userId, portfolioId, symbol: 'AAPL', side: 'SELL', type: 'MARKET',
        requestedQuantity: 100, isLiquidation: true, status: 'PENDING',
        idempotencyKey: 'liq_dummy'
      }
    });

    // 2. Evaluate -> Margin is > 120%. Should cancel the order.
    await (worker as any).evaluatePortfolio(portfolioId);

    const orders = await prisma.order.findMany({ where: { portfolioId } });
    expect(orders[0].status).toBe('CANCELLED');
  });

  it('should select highest IM contribution symbol for liquidation (regression)', async () => {
    // We want a scenario where Position A has HIGHER notional at refPrice, but Position B has HIGHER IM contribution at executable price.
    // Let's use AAPL and TSLA. 
    // AAPL: 100 * 100 = 10,000 notional.
    // TSLA: -49 * 200 = 9,800 notional.
    // Assuming 50% IM rate and standard liquidity spread:
    // Long AAPL executable BID is lower than 100 (e.g. 99). IM = 100 * 99 * 0.5 = 4,950
    // Short TSLA executable ASK is higher than 200 (e.g. 202). IM = 49 * 202 * 0.5 = 4,949...
    // Let's make TSLA 49.5 maybe? No, let's just make TSLA short qty = -49, refPrice = 200, notional = 9800.
    // If ASK is 205 (2.5% slippage), then IM = 49 * 205 * 0.5 = 5,022.5.
    // AAPL notional = 10,000 > TSLA notional 9,800.
    // BUT TSLA IM = 5,022.5 > AAPL IM 4,950.
    
    await prisma.portfolio.update({ where: { id: portfolioId }, data: { totalCash: -25000 } });
    
    await prisma.position.create({
      data: { portfolioId, symbol: 'AAPL', quantity: 100, averageEntryPrice: 100, status: 'OPEN' }
    });
    // TSLA qty is -49.2 to make notional strictly lower
    await prisma.position.create({
      data: { portfolioId, symbol: 'TSLA', quantity: -49.99, averageEntryPrice: 200, status: 'OPEN' }
    });

    await (worker as any).evaluatePortfolio(portfolioId);

    const orders = await prisma.order.findMany({ where: { portfolioId, isLiquidation: true } });
    expect(orders.length).toBe(1);
    expect(orders[0].symbol).toBe('TSLA'); // Selected because of IM!
    expect(Number(orders[0].requestedQuantity)).toBe(49.99);
    expect(orders[0].side).toBe('BUY'); // Since it's a short position
  });
});
