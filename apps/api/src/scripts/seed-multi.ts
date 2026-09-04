import dotenv from "dotenv";
dotenv.config();
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding multi-user environment...');

  for (let i = 1; i <= 20; i++) {
    const e2eEmail = `playwright${i}@tradealpha.local`;
    
    // Clean up
    const existingUser = await prisma.user.findUnique({ where: { email: e2eEmail } });
    if (existingUser) {
      await prisma.portfolioSnapshot.deleteMany({ where: { portfolio: { userId: existingUser.id } } });
      await prisma.orderFill.deleteMany({ where: { order: { portfolio: { userId: existingUser.id } } } });
      await prisma.order.deleteMany({ where: { portfolio: { userId: existingUser.id } } });
      await prisma.position.deleteMany({ where: { portfolio: { userId: existingUser.id } } });
      await prisma.portfolio.deleteMany({ where: { userId: existingUser.id } });
      await prisma.user.delete({ where: { id: existingUser.id } });
    }

    const passwordHash = await bcrypt.hash('Playwright123!', 10);
    const user = await prisma.user.create({
      data: {
        email: e2eEmail,
        passwordHash,
      },
    });

    await prisma.portfolio.create({
      data: {
        userId: user.id,
        totalCash: 1000000000,
      },
    });
    console.log(`Seeded user ${i}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
