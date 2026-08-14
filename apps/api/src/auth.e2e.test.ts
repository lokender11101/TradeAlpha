import request from 'supertest';
import { app, httpServer, wsServer } from './main.api';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const secret = process.env.JWT_SECRET || 'fallback-secret-for-tests';

describe('Authentication & Impersonation E2E', () => {
  let userA: any;
  let userB: any;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    // Ensure clean state
    await prisma.orderFill.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.position.deleteMany({});
    await prisma.portfolio.deleteMany({});
    await prisma.user.deleteMany({});

    userA = await prisma.user.create({
      data: {
        email: 'usera@test.com',
        passwordHash: 'hash',
        portfolios: { create: { totalCash: 100000 } }
      },
      include: { portfolios: true }
    });

    userB = await prisma.user.create({
      data: {
        email: 'userb@test.com',
        passwordHash: 'hash',
        portfolios: { create: { totalCash: 100000 } }
      },
      include: { portfolios: true }
    });

    tokenA = jwt.sign({ email: userA.email }, secret, { subject: userA.id });
    tokenB = jwt.sign({ email: userB.email }, secret, { subject: userB.id });
  });

  afterAll(async () => {
    await prisma.orderFill.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.position.deleteMany({});
    await prisma.portfolio.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.$disconnect();
    await wsServer.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  // --- REST Authentication Tests ---

  it('should return 401 for missing token on protected route', async () => {
    const res = await request(app).post('/api/orders')
      .set('Cookie', 'csrf_token=test')
      .set('x-csrf-token', 'test')
      .send({});
    expect(res.status).toBe(401);
  });

  it('should return 401 for malformed Authorization header', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', 'csrf_token=test')
      .set('x-csrf-token', 'test')
      .set('Authorization', 'Bearer ')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Malformed token/);
  });

  it('should return 401 for invalid signature', async () => {
    const badToken = jwt.sign({}, 'wrong-secret', { subject: userA.id });
    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', `token=${badToken}; csrf_token=test`)
      .set('x-csrf-token', 'test')
      .set('Authorization', `Bearer ${badToken}`)
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid signature/);
  });

  it('should return 401 for expired token', async () => {
    const expiredToken = jwt.sign({}, secret, { subject: userA.id, expiresIn: '-1h' } as any);
    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', `token=${expiredToken}; csrf_token=test`)
      .set('x-csrf-token', 'test')
      .set('Authorization', `Bearer ${expiredToken}`)
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Token expired/);
  });

  it('should create order as User A even if request body contains User B userId (impersonation blocked)', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', [`token=${tokenA}`, `csrf_token=test`])
      .set('x-csrf-token', 'test')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        userId: userB.id, // Malicious impersonation attempt
        portfolioId: userA.portfolios[0].id,
        symbol: 'AAPL',
        side: 'BUY',
        type: 'LIMIT',
        requestedQuantity: 1,
        limitPrice: 150,
        currentMarketPrice: 155,
        idempotencyKey: 'impersonation-test-key-1'
      });

    expect(res.status).toBe(201);
    
    // Verify the order was actually created for User A, NOT User B
    const order = await prisma.order.findUnique({ where: { id: res.body.id } });
    expect(order?.userId).toBe(userA.id);
    expect(order?.userId).not.toBe(userB.id);
  });

  it('should deny User A accessing User B portfolio positions (403 Forbidden)', async () => {
    const res = await request(app)
      .get(`/api/portfolios/${userB.portfolios[0].id}/positions`)
      .set('Cookie', `token=${tokenA}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(403);
  });

  it('should allow User B to access their own portfolio positions', async () => {
    const res = await request(app)
      .get(`/api/portfolios/${userB.portfolios[0].id}/positions`)
      .set('Cookie', `token=${tokenB}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(200);
  });

  // --- Auth flow (register + login) ---

  it('should register and login to receive a JWT, then use it', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({ email: 'newuser@test.com', password: 'securepassword123' });
    expect(regRes.status).toBe(201);
    expect(regRes.body).toHaveProperty('id');

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'newuser@test.com', password: 'securepassword123' });
    expect(loginRes.status).toBe(200);

    const setCookieHeader = loginRes.headers['set-cookie'] as unknown as string[];
    const tokenCookie = (setCookieHeader || []).find((c: string) => c.startsWith('token='));
    const token = tokenCookie ? tokenCookie.split(';')[0].split('=')[1] : '';
    expect(token).toBeTruthy();

    // Use the token on a protected route
    const newUserPortfolio = await prisma.portfolio.findFirst({
      where: { user: { email: 'newuser@test.com' } }
    });
    
    const positionsRes = await request(app)
      .get(`/api/portfolios/${newUserPortfolio!.id}/positions`)
      .set('Cookie', `token=${token}`)
      .set('Authorization', `Bearer ${token}`);
    expect(positionsRes.status).toBe(200);
  });
});
