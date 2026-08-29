import { PrismaClient, Prisma, OrderStatus } from '@prisma/client';
import { OrderService } from '../apps/api/src/services/order.service';
import { PortfolioValuationService } from '../apps/api/src/services/portfolio-valuation.service';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();
const vs = new PortfolioValuationService(prisma);
const os = new OrderService(prisma);

async function runTest() {
  const user = await prisma.user.create({ data: { email: `test_margin_${randomUUID()}@example.com`, passwordHash: 'hash' } });
  
  // Create margin portfolio with $10,000
  const portfolio = await prisma.portfolio.create({
    data: { userId: user.id, totalCash: 10000, isMarginEnabled: true }
  });

  // 1. BUY 10 AAPL @ 200 => Market price 200, res = 210, cost = 2100.
  // Initial Margin = 50% = 1050.
  // Free Margin = 10000.
  const o1 = await os.placeOrder({
    userId: user.id, portfolioId: portfolio.id, symbol: 'AAPL', side: 'BUY', type: 'MARKET',
    requestedQuantity: '10', currentMarketPrice: '200', idempotencyKey: randomUUID()
  });

  const p1 = await prisma.portfolio.findUnique({ where: { id: portfolio.id } });
  console.log('1. After BUY 10 AAPL (Exposure Increasing):');
  console.log('   Locked Cash:', p1?.lockedCash.toString()); // should be 0!
  console.log('   Locked Margin:', p1?.lockedMargin.toString()); // should be 10 * 210 * 0.5 = 1050

  // Cancel order
  await os.cancelOrder(o1.id);
  const p2 = await prisma.portfolio.findUnique({ where: { id: portfolio.id } });
  console.log('2. After Cancel:');
  console.log('   Locked Margin:', p2?.lockedMargin.toString()); // should be 0

  // Buy and Fill 10 AAPL @ 200
  const o2 = await os.placeOrder({
    userId: user.id, portfolioId: portfolio.id, symbol: 'AAPL', side: 'BUY', type: 'MARKET',
    requestedQuantity: '10', currentMarketPrice: '200', idempotencyKey: randomUUID()
  });
  
  // Fill order
  await os.processFill({
    orderId: o2.id, fillIdempotencyKey: randomUUID(), price: '200', quantity: '10'
  });
  
  const p3 = await prisma.portfolio.findUnique({ where: { id: portfolio.id } });
  const val3 = await vs.getValuation(portfolio.id);
  console.log('3. After Fill 10 AAPL @ 200:');
  console.log('   Total Cash:', p3?.totalCash.toString()); // 8000
  console.log('   Locked Margin:', p3?.lockedMargin.toString()); // 0
  console.log('   Equity:', val3.totalNav); // 10000
  console.log('   Used Margin (IM):', val3.initialMargin); // 10 * 200 * 0.5 = 1000
  console.log('   Free Margin:', val3.freeMargin); // 9000

  // Sell 5 AAPL (Exposure Reducing)
  const o3 = await os.placeOrder({
    userId: user.id, portfolioId: portfolio.id, symbol: 'AAPL', side: 'SELL', type: 'MARKET',
    requestedQuantity: '5', currentMarketPrice: '200', idempotencyKey: randomUUID()
  });
  
  const p4 = await prisma.portfolio.findUnique({ where: { id: portfolio.id } });
  console.log('4. After SELL 5 AAPL (Exposure Reducing):');
  console.log('   Locked Margin:', p4?.lockedMargin.toString()); // should be 0, because it's reducing!

  // Sell 15 AAPL (5 reducing, 10 increasing)
  const o4 = await os.placeOrder({
    userId: user.id, portfolioId: portfolio.id, symbol: 'AAPL', side: 'SELL', type: 'MARKET',
    requestedQuantity: '15', currentMarketPrice: '200', idempotencyKey: randomUUID()
  });

  const p5 = await prisma.portfolio.findUnique({ where: { id: portfolio.id } });
  console.log('5. After SELL 15 AAPL (Cross zero):');
  console.log('   Locked Margin:', p5?.lockedMargin.toString()); // should be 10 * 190 * 0.5 = 950
}

runTest().catch(console.error).finally(() => prisma.$disconnect());
