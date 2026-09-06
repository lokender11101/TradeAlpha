import 'dotenv/config';
import request from 'supertest';
import { app } from './main.api';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
const redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
import crypto from 'crypto';
import { ApiKeysService } from './services/api-keys.service';

const prisma = new PrismaClient();
const apiKeysService = new ApiKeysService();

describe('Public API HMAC E2E', () => {
  let userId: string;
  let portfolioId: string;
  let apiKeyPrefix: string;
  let plaintextSecret: string;
  let hmacSecret: string;

  beforeAll(async () => {
    // Create user & portfolio
    const user = await prisma.user.create({
      data: { email: `public-api-${Date.now()}@example.com`, passwordHash: 'hash' },
    });
    userId = user.id;

    const portfolio = await prisma.portfolio.create({
      data: { userId, totalCash: 100000, isMarginEnabled: true },
    });
    portfolioId = portfolio.id;

    // Create API Key
    const { apiKey, plaintextSecret: rawSecret } = await apiKeysService.createKey(userId, 'Test Key', ['orders:write', 'portfolio:read']);
    apiKeyPrefix = apiKey.keyPrefix;
    plaintextSecret = rawSecret;
    // Extract the HMAC secret from the plaintext string (prefix.secret)
    hmacSecret = plaintextSecret.split('.')[1];
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId } });
    await prisma.portfolio.deleteMany({ where: { userId } });
    await prisma.apiKey.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
    redisClient.quit();
  });

  function signRequest(method: string, path: string, body: any, timestamp: number, secret: string) {
    const bodyStr = Object.keys(body).length > 0 ? JSON.stringify(body) : '';
    const canonicalString = `${method}\n${path}\n${timestamp}\n${bodyStr}`;
    return crypto.createHmac('sha256', secret).update(canonicalString).digest('hex');
  }

  it('should reject request without headers', async () => {
    const res = await request(app).get(`/api/public/portfolios/${portfolioId}`);
    expect(res.status).toBe(401);
  });

  it('should accept valid HMAC signature for portfolio read', async () => {
    const timestamp = Date.now();
    const signature = signRequest('GET', `/api/public/portfolios/${portfolioId}`, {}, timestamp, hmacSecret);

    const res = await request(app)
      .get(`/api/public/portfolios/${portfolioId}`)
      .set('x-api-key', apiKeyPrefix)
      .set('x-timestamp', timestamp.toString())
      .set('x-signature', signature);

    expect(res.status).toBe(200);
    expect(res.body.totalCash).toBeDefined();
  });

  it('should reject modified timestamp', async () => {
    const timestamp = Date.now();
    const signature = signRequest('GET', `/api/public/portfolios/${portfolioId}`, {}, timestamp, hmacSecret);

    const res = await request(app)
      .get(`/api/public/portfolios/${portfolioId}`)
      .set('x-api-key', apiKeyPrefix)
      .set('x-timestamp', (timestamp + 100).toString()) // Changed
      .set('x-signature', signature);

    expect(res.status).toBe(401);
  });

  it('should reject replay attack (same signature)', async () => {
    const timestamp = Date.now();
    const signature = signRequest('GET', `/api/public/portfolios/${portfolioId}?replay=1`, {}, timestamp, hmacSecret);

    // First request should succeed
    const res1 = await request(app)
      .get(`/api/public/portfolios/${portfolioId}?replay=1`)
      .set('x-api-key', apiKeyPrefix)
      .set('x-timestamp', timestamp.toString())
      .set('x-signature', signature);
    expect(res1.status).toBe(200);

    // Second identical request should be rejected as replay
    const res2 = await request(app)
      .get(`/api/public/portfolios/${portfolioId}?replay=1`)
      .set('x-api-key', apiKeyPrefix)
      .set('x-timestamp', timestamp.toString())
      .set('x-signature', signature);
    expect(res2.status).toBe(401);
    expect(res2.body.error).toContain('Replay attack');
  });

  it('should place an order via public API', async () => {
    const payload = {
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      requestedQuantity: 10,
      currentMarketPrice: 150,
      idempotencyKey: crypto.randomUUID()
    };
    
    // express body parser might format json without spaces, we use JSON.stringify in test
    const timestamp = Date.now();
    const signature = signRequest('POST', '/api/public/orders', payload, timestamp, hmacSecret);

    const res = await request(app)
      .post('/api/public/orders')
      .set('x-api-key', apiKeyPrefix)
      .set('x-timestamp', timestamp.toString())
      .set('x-signature', signature)
      .set('Content-Type', 'application/json')
      .send(payload);

    if(res.status !== 201) console.error(res.body);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(['RECEIVED', 'VALIDATED', 'ACCEPTED']).toContain(res.body.status); // Or VALIDATED/ACCEPTED depending on sync flow
  });
});
