import { PrismaClient, Prisma, PositionStatus } from '@prisma/client';
import { PositionService } from './position.service';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

describe('PositionService - Phase 9.2 Short Selling', () => {
  let userId: string;
  let portfolioId: string;
  let portfolioMarginId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `test_short_${randomUUID()}@example.com`, passwordHash: 'hash' }
    });
    userId = user.id;

    const port = await prisma.portfolio.create({
      data: { userId, totalCash: 10000, isMarginEnabled: false }
    });
    portfolioId = port.id;

    const portMargin = await prisma.portfolio.create({
      data: { userId, totalCash: 10000, isMarginEnabled: true }
    });
    portfolioMarginId = portMargin.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('1. OPEN SHORT (Margin Enabled)', async () => {
    await prisma.$transaction(async (tx) => {
      const position = await PositionService.lockPosition(tx, portfolioMarginId, 'AAPL', new Prisma.Decimal(10));
      expect(position.lockedQuantity.toString()).toBe('10');

      const { position: p1, realizedPnl } = await PositionService.adjustOnSell(tx, portfolioMarginId, 'AAPL', new Prisma.Decimal(10), new Prisma.Decimal(100));
      expect(p1.quantity.toString()).toBe('-10');
      expect(p1.averageEntryPrice.toString()).toBe('100');
      expect(p1.status).toBe(PositionStatus.OPEN);
      expect(realizedPnl.toString()).toBe('0');
    });
  });

  it('2. INCREASE SHORT & Average Entry (Margin Enabled)', async () => {
    await prisma.$transaction(async (tx) => {
      await PositionService.lockPosition(tx, portfolioMarginId, 'AAPL', new Prisma.Decimal(10));
      const { position: p1, realizedPnl } = await PositionService.adjustOnSell(tx, portfolioMarginId, 'AAPL', new Prisma.Decimal(10), new Prisma.Decimal(110));
      expect(p1.quantity.toString()).toBe('-20');
      // avg = (10 * 100 + 10 * 110) / 20 = 105
      expect(p1.averageEntryPrice.toString()).toBe('105');
      expect(realizedPnl.toString()).toBe('0');
    });
  });

  it('3. PARTIAL COVER (Margin Enabled)', async () => {
    await prisma.$transaction(async (tx) => {
      const { position: p1, realizedPnl } = await PositionService.adjustOnBuy(tx, portfolioMarginId, 'AAPL', new Prisma.Decimal(5), new Prisma.Decimal(90));
      // Remaining: -15. Realized PnL: (105 - 90) * 5 = +75
      expect(p1.quantity.toString()).toBe('-15');
      expect(p1.averageEntryPrice.toString()).toBe('105');
      expect(realizedPnl.toString()).toBe('75');
    });
  });

  it('4. FULL COVER (Margin Enabled)', async () => {
    await prisma.$transaction(async (tx) => {
      const { position: p1, realizedPnl } = await PositionService.adjustOnBuy(tx, portfolioMarginId, 'AAPL', new Prisma.Decimal(15), new Prisma.Decimal(110));
      // Remaining: 0. Realized PnL: (105 - 110) * 15 = -75
      expect(p1.quantity.toString()).toBe('0');
      expect(p1.status).toBe(PositionStatus.CLOSED);
      expect(realizedPnl.toString()).toBe('-75');
    });
  });

  it('5. SHORT TO LONG CROSSING (Margin Enabled)', async () => {
    await prisma.$transaction(async (tx) => {
      await PositionService.lockPosition(tx, portfolioMarginId, 'TSLA', new Prisma.Decimal(10));
      await PositionService.adjustOnSell(tx, portfolioMarginId, 'TSLA', new Prisma.Decimal(10), new Prisma.Decimal(200));

      const { position: p1, realizedPnl } = await PositionService.adjustOnBuy(tx, portfolioMarginId, 'TSLA', new Prisma.Decimal(15), new Prisma.Decimal(190));
      // Crosses from -10 to +5.
      // Cover 10: PnL = (200 - 190) * 10 = +100
      // Open 5 @ 190.
      expect(p1.quantity.toString()).toBe('5');
      expect(p1.averageEntryPrice.toString()).toBe('190');
      expect(p1.status).toBe(PositionStatus.OPEN);
      expect(realizedPnl.toString()).toBe('100');
    });
  });

  it('6. LONG TO SHORT CROSSING (Margin Enabled)', async () => {
    await prisma.$transaction(async (tx) => {
      await PositionService.lockPosition(tx, portfolioMarginId, 'TSLA', new Prisma.Decimal(15));
      const { position: p1, realizedPnl } = await PositionService.adjustOnSell(tx, portfolioMarginId, 'TSLA', new Prisma.Decimal(15), new Prisma.Decimal(210));
      // Crosses from 5 to -10.
      // Close 5: PnL = (210 - 190) * 5 = +100
      // Open 10 @ 210.
      expect(p1.quantity.toString()).toBe('-10');
      expect(p1.averageEntryPrice.toString()).toBe('210');
      expect(realizedPnl.toString()).toBe('100');
    });
  });

  it('7. MARGIN DISABLED REJECTION', async () => {
    await prisma.$transaction(async (tx) => {
      await expect(PositionService.lockPosition(tx, portfolioId, 'MSFT', new Prisma.Decimal(10)))
        .rejects.toThrow('Insufficient quantity');
    });
  });
});
