import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding Playwright E2E environment...');

  const e2eEmail = 'playwright@tradealpha.local';
  
  // Clean up previous test runs if any
  const existingUser = await prisma.user.findUnique({ where: { email: e2eEmail } });
  if (existingUser) {
    console.log(`Cleaning up existing user ${e2eEmail}...`);
    // Delete related entities first
    const portfolios = await prisma.portfolio.findMany({ where: { userId: existingUser.id } });
    for (const portfolio of portfolios) {
      await prisma.orderFill.deleteMany({ where: { order: { portfolioId: portfolio.id } } });
      await prisma.order.deleteMany({ where: { portfolioId: portfolio.id } });
      await prisma.position.deleteMany({ where: { portfolioId: portfolio.id } });
    }
    await prisma.portfolio.deleteMany({ where: { userId: existingUser.id } });
    await prisma.user.delete({ where: { id: existingUser.id } });
  }

  // Create new user
  const passwordHash = await bcrypt.hash('Playwright123!', 10);
  const user = await prisma.user.create({
    data: {
      email: e2eEmail,
      passwordHash,
    },
  });

  // Create portfolio with 1,000,000 cash
  const portfolio = await prisma.portfolio.create({
    data: {
      userId: user.id,
      totalCash: 1000000,
    },
  });

  console.log(`Seeded E2E User: ${e2eEmail}`);
  console.log(`Seeded Portfolio: ${portfolio.id}`);
  console.log('E2E Seeding completed.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
