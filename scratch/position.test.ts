import { PrismaClient, PositionStatus } from '@prisma/client';
import { PositionService } from '../apps/api/src/services/position.service';

const prisma = new PrismaClient();

async function runTest() {
  const user = await prisma.user.create({ data: { email: 'test_short@example.com', passwordHash: 'hash', role: 'USER' } });
  const portfolio = await prisma.portfolio.create({ data: { userId: user.id, isMarginEnabled: true } });
  
  await prisma.$transaction(async (tx) => {
    // 1. Check checkPosition
    const p1 = await PositionService.checkPosition(tx, portfolio.id, 'AAPL', new Prisma.Decimal(10));
    console.log('p1:', p1); // null

    // 2. Lock position
    const p2 = await PositionService.lockPosition(tx, portfolio.id, 'AAPL', new Prisma.Decimal(10));
    console.log('p2 lockedQty:', p2.lockedQuantity.toString()); // 10

    // 3. Sell 5 AAPL at 100
    const { position: p3, realizedPnl: pnl3 } = await PositionService.adjustOnSell(tx, portfolio.id, 'AAPL', new Prisma.Decimal(5), new Prisma.Decimal(100));
    console.log('p3 qty:', p3.quantity.toString(), 'locked:', p3.lockedQuantity.toString(), 'pnl:', pnl3.toString(), 'avg:', p3.averageEntryPrice.toString());

    // 4. Sell 5 AAPL at 110
    const { position: p4, realizedPnl: pnl4 } = await PositionService.adjustOnSell(tx, portfolio.id, 'AAPL', new Prisma.Decimal(5), new Prisma.Decimal(110));
    console.log('p4 qty:', p4.quantity.toString(), 'locked:', p4.lockedQuantity.toString(), 'pnl:', pnl4.toString(), 'avg:', p4.averageEntryPrice.toString());

    // 5. Buy 4 AAPL at 90 (Cover)
    const { position: p5, realizedPnl: pnl5 } = await PositionService.adjustOnBuy(tx, portfolio.id, 'AAPL', new Prisma.Decimal(4), new Prisma.Decimal(90));
    console.log('p5 qty:', p5.quantity.toString(), 'pnl:', pnl5.toString(), 'avg:', p5.averageEntryPrice.toString());
  });
}
runTest().catch(console.error).finally(() => prisma.$disconnect());
