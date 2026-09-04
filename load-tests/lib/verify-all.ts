import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  for (let i = 1; i <= 20; i++) {
    const user = await prisma.user.findUnique({ where: { email: `playwright${i}@tradealpha.local` } });
    if (!user) continue;
    const p = await prisma.portfolio.findFirst({ where: { userId: user.id } });
    if (!p) continue;
    const orders = await prisma.order.count({ where: { portfolioId: p.id } });
    const totalCash = Number(p.totalCash);
    const lockedCash = Number(p.lockedCash);
    console.log(`User ${i}: ${orders} orders. Cash: ${totalCash}, Locked: ${lockedCash}`);
    if (lockedCash > totalCash) {
       console.error(`User ${i} HAS NEGATIVE MARGIN`);
       process.exit(1);
    }
  }
  process.exit(0);
}
run();
