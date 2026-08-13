import { PrismaClient, PositionStatus } from '@prisma/client';
import { PositionService } from './position.service';
import { Prisma } from '@prisma/client';

const prisma = new PrismaClient();

describe('PositionService (Phase 2.7)', () => {
  let userId: string;
  let portfolioId: string;

  beforeAll(async () => {
    // Clear state
    await prisma.outboxEvent.deleteMany({});
    await prisma.ledgerEntry.deleteMany({});
    await prisma.ledgerTransaction.deleteMany({});
    await prisma.orderFill.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.position.deleteMany({});
    await prisma.portfolio.deleteMany({});
    await prisma.user.deleteMany({});

    // Setup User and Portfolio
    const user = await prisma.user.create({
      data: { email: `pos-test-${Date.now()}@example.com`, passwordHash: 'hash' }
    });
    userId = user.id;

    const portfolio = await prisma.portfolio.create({
      data: { userId, totalCash: 100000, lockedCash: 0 }
    });
    portfolioId = portfolio.id;
  });

  beforeEach(async () => {
    await prisma.position.deleteMany({});
    await prisma.outboxEvent.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('adjustOnBuy (WAC)', () => {
    it('should create a new position (POSITION_OPENED)', async () => {
      await prisma.$transaction(async (tx) => {
        const position = await PositionService.adjustOnBuy(tx, portfolioId, 'AAPL', new Prisma.Decimal(10), new Prisma.Decimal(150));
        
        expect(position.quantity.toNumber()).toBe(10);
        expect(position.averageEntryPrice.toNumber()).toBe(150);
        expect(position.status).toBe(PositionStatus.OPEN);
        expect(position.realizedPnl.toNumber()).toBe(0);

        const events = await tx.outboxEvent.findMany();
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('POSITION_OPENED');
      });
    });

    it('should correctly calculate Weighted Average Cost on consecutive buys (POSITION_UPDATED)', async () => {
      await prisma.$transaction(async (tx) => {
        await PositionService.adjustOnBuy(tx, portfolioId, 'AAPL', new Prisma.Decimal(10), new Prisma.Decimal(100));
        const position = await PositionService.adjustOnBuy(tx, portfolioId, 'AAPL', new Prisma.Decimal(10), new Prisma.Decimal(150));
        
        // 10*100 + 10*150 = 2500 / 20 = 125
        expect(position.quantity.toNumber()).toBe(20);
        expect(position.averageEntryPrice.toNumber()).toBe(125);
        expect(position.status).toBe(PositionStatus.OPEN);
        expect(position.realizedPnl.toNumber()).toBe(0);

        const events = await tx.outboxEvent.findMany();
        expect(events).toHaveLength(2);
        expect(events[1].type).toBe('POSITION_UPDATED');
      });
    });
  });

  describe('adjustOnSell (Realized PnL)', () => {
    it('should accurately calculate realized PnL on a profitable partial sell', async () => {
      await prisma.$transaction(async (tx) => {
        await PositionService.adjustOnBuy(tx, portfolioId, 'TSLA', new Prisma.Decimal(10), new Prisma.Decimal(200));
        await PositionService.lockPosition(tx, portfolioId, 'TSLA', new Prisma.Decimal(4));
        
        const { position, realizedPnl } = await PositionService.adjustOnSell(tx, portfolioId, 'TSLA', new Prisma.Decimal(4), new Prisma.Decimal(250));
        
        // PnL = (250 - 200) * 4 = +200
        expect(realizedPnl.toNumber()).toBe(200);
        
        expect(position.quantity.toNumber()).toBe(6);
        expect(position.averageEntryPrice.toNumber()).toBe(200); // average untouched
        expect(position.realizedPnl.toNumber()).toBe(200);
        expect(position.status).toBe(PositionStatus.OPEN);

        const events = await tx.outboxEvent.findMany();
        expect(events[events.length - 1].type).toBe('POSITION_UPDATED');
      });
    });

    it('should accurately calculate realized PnL on a losing partial sell', async () => {
      await prisma.$transaction(async (tx) => {
        await PositionService.adjustOnBuy(tx, portfolioId, 'TSLA', new Prisma.Decimal(10), new Prisma.Decimal(200));
        await PositionService.lockPosition(tx, portfolioId, 'TSLA', new Prisma.Decimal(4));
        
        const { position, realizedPnl } = await PositionService.adjustOnSell(tx, portfolioId, 'TSLA', new Prisma.Decimal(4), new Prisma.Decimal(150));
        
        // PnL = (150 - 200) * 4 = -200
        expect(realizedPnl.toNumber()).toBe(-200);
        expect(position.realizedPnl.toNumber()).toBe(-200);
      });
    });

    it('should emit POSITION_CLOSED when fully exited and preserve cumulative realizedPnl', async () => {
      await prisma.$transaction(async (tx) => {
        await PositionService.adjustOnBuy(tx, portfolioId, 'MSFT', new Prisma.Decimal(10), new Prisma.Decimal(100));
        await PositionService.lockPosition(tx, portfolioId, 'MSFT', new Prisma.Decimal(10));
        
        const { position, realizedPnl } = await PositionService.adjustOnSell(tx, portfolioId, 'MSFT', new Prisma.Decimal(10), new Prisma.Decimal(120));
        
        expect(realizedPnl.toNumber()).toBe(200);
        expect(position.quantity.toNumber()).toBe(0);
        expect(position.lockedQuantity.toNumber()).toBe(0);
        expect(position.realizedPnl.toNumber()).toBe(200);
        expect(position.status).toBe(PositionStatus.CLOSED);

        const events = await tx.outboxEvent.findMany();
        expect(events[events.length - 1].type).toBe('POSITION_CLOSED');
      });
    });

    it('should correctly reset average on reopen but accumulate realizedPnl', async () => {
      await prisma.$transaction(async (tx) => {
        // Buy 10 @ 100
        await PositionService.adjustOnBuy(tx, portfolioId, 'MSFT', new Prisma.Decimal(10), new Prisma.Decimal(100));
        // Sell 10 @ 120 -> +200 PnL
        await PositionService.lockPosition(tx, portfolioId, 'MSFT', new Prisma.Decimal(10));
        await PositionService.adjustOnSell(tx, portfolioId, 'MSFT', new Prisma.Decimal(10), new Prisma.Decimal(120));
        
        // Reopen Buy 5 @ 150
        const reopened = await PositionService.adjustOnBuy(tx, portfolioId, 'MSFT', new Prisma.Decimal(5), new Prisma.Decimal(150));
        
        // Avg must be 150 (not blended with historical closed)
        expect(reopened.averageEntryPrice.toNumber()).toBe(150);
        expect(reopened.quantity.toNumber()).toBe(5);
        expect(reopened.status).toBe(PositionStatus.OPEN);
        // Realized PnL MUST accumulate
        expect(reopened.realizedPnl.toNumber()).toBe(200);

        const events = await tx.outboxEvent.findMany();
        expect(events[events.length - 1].type).toBe('POSITION_OPENED'); // because it was reopened from CLOSED
      });
    });

    it('should prevent overselling against quantity and lockedQuantity', async () => {
      await prisma.$transaction(async (tx) => {
        await PositionService.adjustOnBuy(tx, portfolioId, 'MSFT', new Prisma.Decimal(10), new Prisma.Decimal(100));
        await PositionService.lockPosition(tx, portfolioId, 'MSFT', new Prisma.Decimal(5)); // Locked 5 for selling
        
        // Try to execute sell for 10 (which is > locked 5)
        await expect(PositionService.adjustOnSell(tx, portfolioId, 'MSFT', new Prisma.Decimal(10), new Prisma.Decimal(100)))
          .rejects.toThrow(/Insufficient locked quantity/);
      });
    });
  });
});
