import { PrismaClient, Prisma, PositionStatus } from '@prisma/client';
import { PortfolioValuationService } from './portfolio-valuation.service';
import { PriceCacheService } from './price-cache.service';

// Mock dependencies
const mockPrisma = {
  portfolio: {
    findUnique: jest.fn(),
  },
} as unknown as PrismaClient;

const mockPriceCache = {
  getLatestPrice: jest.fn(),
} as unknown as PriceCacheService;

describe('PortfolioValuationService - Phase 9.1', () => {
  let valuationService: PortfolioValuationService;

  beforeEach(() => {
    jest.clearAllMocks();
    valuationService = new PortfolioValuationService(mockPrisma, mockPriceCache);
  });

  it('1. Cash-only account', async () => {
    (mockPrisma.portfolio.findUnique as jest.Mock).mockResolvedValue({
      id: 'port_1',
      totalCash: new Prisma.Decimal(1000),
      lockedCash: new Prisma.Decimal(0),
      lockedMargin: new Prisma.Decimal(0),
      isMarginEnabled: false,
      positions: []
    });

    const result = await valuationService.getValuation('port_1');
    expect(result.totalNav).toBe('1000.0000');
    expect(result.totalCash).toBe('1000.0000');
    expect(result.grossExposure).toBe('0.0000');
    expect(result.longMarketValue).toBe('0.0000');
    expect(result.shortLiabilityValue).toBe('0.0000');
    expect(result.freeMargin).toBe('1000.0000');
    expect(result.usedMargin).toBe('0.0000');
    expect(result.marginLevel).toBeNull();
    expect(result.buyingPower).toBe('2000.0000'); // 0 / 0.50 ? No, wait. 1000 / 0.50 = 2000
    // Wait, FreeMargin = 1000, IM_Rate = 0.50, BuyingPower = 2000
  });

  it('2. Long position valuation using BID', async () => {
    // We mock DEFAULT liquidity profile: spread 0.05, slippage 0.02, depth 1000
    // Bid = ref - spread/2 - slippage*level
    // level = 0 for qty 10. Bid = 100 - 0.025 - 0 = 99.975
    (mockPrisma.portfolio.findUnique as jest.Mock).mockResolvedValue({
      id: 'port_1',
      totalCash: new Prisma.Decimal(100),
      lockedCash: new Prisma.Decimal(0),
      lockedMargin: new Prisma.Decimal(0),
      isMarginEnabled: false,
      positions: [
        { symbol: 'DEFAULT', quantity: new Prisma.Decimal(10), averageEntryPrice: new Prisma.Decimal(100), status: PositionStatus.OPEN, realizedPnl: new Prisma.Decimal(0) }
      ]
    });

    (mockPriceCache.getLatestPrice as jest.Mock).mockResolvedValue({
      price: '100',
      isStale: false
    });

    const result = await valuationService.getValuation('port_1');
    // LMV = 10 * 99.975 = 999.75
    expect(result.longMarketValue).toBe('999.7500');
    expect(result.shortLiabilityValue).toBe('0.0000');
    expect(result.totalNav).toBe('1099.7500');
    // IM = 999.75 * 0.5 = 499.875
    expect(result.initialMargin).toBe('499.8750');
    // MM = 999.75 * 0.25 = 249.9375
    expect(result.maintenanceMargin).toBe('249.9375');
    // Free Margin = 1099.75 - 499.875 = 599.875
    expect(result.freeMargin).toBe('599.8750');
    // Buying Power = 599.875 / 0.5 = 1199.75
    expect(result.buyingPower).toBe('1199.7500');
  });

  it('3. Short-position formula using ASK', async () => {
    // DEFAULT profile: spread 0.05. Ask = ref + 0.025. Ask = 100.025
    (mockPrisma.portfolio.findUnique as jest.Mock).mockResolvedValue({
      id: 'port_1',
      totalCash: new Prisma.Decimal(1100), // Original 100 + 1000 short proceeds
      lockedCash: new Prisma.Decimal(0),
      lockedMargin: new Prisma.Decimal(0),
      isMarginEnabled: true,
      positions: [
        { symbol: 'DEFAULT', quantity: new Prisma.Decimal(-10), averageEntryPrice: new Prisma.Decimal(100), status: PositionStatus.OPEN, realizedPnl: new Prisma.Decimal(0) }
      ]
    });

    (mockPriceCache.getLatestPrice as jest.Mock).mockResolvedValue({
      price: '100',
      isStale: false
    });

    const result = await valuationService.getValuation('port_1');
    // SMV = 10 * 100.025 = 1000.25
    expect(result.shortLiabilityValue).toBe('1000.2500');
    expect(result.longMarketValue).toBe('0.0000');
    // Equity = C + LMV - SMV = 1100 - 1000.25 = 99.75
    expect(result.totalNav).toBe('99.7500');
    // Equity explicitly does not double-count short proceeds
    // IM = 1000.25 * 0.5 = 500.125
    expect(result.initialMargin).toBe('500.1250');
    // Free Margin = 99.75 - 500.125 = -400.375
    expect(result.freeMargin).toBe('-400.3750');
  });
});
