import { PrismaClient } from '@prisma/client';
import { EodSweepService } from './eod-sweep.service';
import * as crypto from 'crypto';

const prisma = new PrismaClient();
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const eodSweepService = new EodSweepService(redisUrl, prisma);

describe('EodSweepService - Snapshot Portfolios', () => {
  let userId: string;
  let portfolioId: string;

  beforeAll(async () => {
    userId = crypto.randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `test-eod-${userId}@example.com`,
        passwordHash: 'hash'
      }
    });
  });

  afterAll(async () => {
    await prisma.portfolioSnapshot.deleteMany({ where: { portfolio: { userId } } });
    await prisma.portfolio.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.portfolioSnapshot.deleteMany({ where: { portfolio: { userId } } });
    await prisma.portfolio.deleteMany({ where: { userId } });
    
    const portfolio = await prisma.portfolio.create({
      data: { userId, totalCash: '10000', lockedCash: '0' }
    });
    portfolioId = portfolio.id;
  });

  it('1. should create a new snapshot for a portfolio', async () => {
    const now = new Date('2026-08-25T10:00:00Z');
    await eodSweepService.snapshotPortfolios(now);

    const snapshots = await prisma.portfolioSnapshot.findMany({ where: { portfolioId } });
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].totalNav.toString()).toBe('10000');
    expect(snapshots[0].totalCash.toString()).toBe('10000');
    expect(snapshots[0].marketValue.toString()).toBe('0');
    
    // Check snapshot date is at midnight UTC
    expect(snapshots[0].snapshotDate.toISOString()).toBe('2026-08-25T00:00:00.000Z');
  });

  it('2. should be idempotent and not create duplicate snapshots for the same date', async () => {
    const now = new Date('2026-08-25T10:00:00Z');
    await eodSweepService.snapshotPortfolios(now);
    await eodSweepService.snapshotPortfolios(now); // Call again

    const snapshots = await prisma.portfolioSnapshot.findMany({ where: { portfolioId } });
    expect(snapshots.length).toBe(1); // Still exactly 1
  });

  it('3. should create a new snapshot for the next date', async () => {
    const day1 = new Date('2026-08-25T10:00:00Z');
    await eodSweepService.snapshotPortfolios(day1);

    const day2 = new Date('2026-08-26T10:00:00Z');
    await eodSweepService.snapshotPortfolios(day2);

    const snapshots = await prisma.portfolioSnapshot.findMany({ where: { portfolioId }, orderBy: { snapshotDate: 'asc' } });
    expect(snapshots.length).toBe(2);
    expect(snapshots[0].snapshotDate.toISOString()).toBe('2026-08-25T00:00:00.000Z');
    expect(snapshots[1].snapshotDate.toISOString()).toBe('2026-08-26T00:00:00.000Z');
  });
});
