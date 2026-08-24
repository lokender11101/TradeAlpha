import request from 'supertest';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { PortfolioController } from './controllers/portfolio.controller';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';

const prisma = new PrismaClient();
const app = express();
app.use(express.json());

// Mock auth middleware for the test
app.get('/api/portfolios/:portfolioId/history', (req: any, res, next) => {
  req.user = { id: req.headers.authorization };
  next();
}, PortfolioController.getHistory);

describe('Portfolio API E2E', () => {
  let userId: string;
  let portfolioId: string;

  beforeAll(async () => {
    userId = crypto.randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `portfolio-api-${userId}@example.com`,
        passwordHash: 'hash'
      }
    });

    const p = await prisma.portfolio.create({
      data: { userId, totalCash: '1000', lockedCash: '0' }
    });
    portfolioId = p.id;

    // Seed history
    await prisma.portfolioSnapshot.createMany({
      data: [
        {
          portfolioId,
          snapshotDate: new Date('2026-01-01T00:00:00Z'),
          totalCash: '1000',
          marketValue: '500',
          totalNav: '1500',
          unrealizedPnl: '50',
          realizedPnl: '10'
        },
        {
          portfolioId,
          snapshotDate: new Date('2026-01-02T00:00:00Z'),
          totalCash: '1000',
          marketValue: '600',
          totalNav: '1600',
          unrealizedPnl: '150',
          realizedPnl: '10'
        }
      ]
    });
  });

  afterAll(async () => {
    await prisma.portfolioSnapshot.deleteMany({ where: { portfolioId } });
    await prisma.portfolio.delete({ where: { id: portfolioId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('1. should return 401 if unauthorized', async () => {
    const res = await request(app).get(`/api/portfolios/${portfolioId}/history`);
    expect(res.status).toBe(401);
  });

  it('2. should return 403 if accessing someone else portfolio', async () => {
    const res = await request(app)
      .get(`/api/portfolios/${portfolioId}/history`)
      .set('Authorization', 'wrong-user-id');
    expect(res.status).toBe(403);
  });

  it('3. should return history ordered asc by date', async () => {
    const res = await request(app)
      .get(`/api/portfolios/${portfolioId}/history`)
      .set('Authorization', userId);
    
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    expect(res.body[0].nav).toBe('1500');
    expect(res.body[1].nav).toBe('1600');
    expect(res.body[0].date).toBe('2026-01-01T00:00:00.000Z');
  });
});
