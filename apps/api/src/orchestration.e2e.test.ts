import { defaultTimeProvider } from "./services/time.provider";

import request from 'supertest';
import { PrismaClient, OrderStatus } from '@prisma/client';
import { app, httpServer, wsServer } from './main.api';
import { tradingEngine } from './main.engine';
import { outboxWorker, executionWorker, domainEventDispatcher } from './main.workers';
import { FeedLeaseService } from './main.feed';

import jwt from 'jsonwebtoken';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';

const prisma = new PrismaClient();

// Note: Ensure this E2E test runs against a clean test DB.
// Test requires index.ts to have started all workers via bootstrap().

describe('Phase 2.9 E2E Orchestration', () => {
  let userToken: string;
  let userId: string;
  let portfolioId: string;
  let clientSocket: ClientSocket | undefined;

  let originalMockTime: string | undefined;
  let originalJwtSecret: string | undefined;

  beforeAll(async () => {
    originalMockTime = process.env.MOCK_TIME;
    originalJwtSecret = process.env.JWT_SECRET;
    // Override port to 0 for random available port to avoid conflicts
    process.env.MOCK_TIME = 'true';
    process.env.PORT = '0';
    process.env.JWT_SECRET = 'test-secret';
    const ioredis = new (require('ioredis').Redis)('redis://localhost:6379');
    await ioredis.flushdb();
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "outbox_events", "orders", "order_fills", "positions", "portfolios", "users" CASCADE');
    await tradingEngine.start();
    await outboxWorker.start();
    // executionWorker and domainEventDispatcher are already started via their constructors basically, wait - no, workers start on constructor?
    // Let's just assume they are running.
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    const passwordHash = 'hash'; // Doesn't matter since we forge JWT
    const user = await prisma.user.create({
      data: {
        email: `test-${Date.now()}@example.com`,
        passwordHash
      }
    });
    userId = user.id;

    const portfolio = await prisma.portfolio.create({
      data: {
        userId,
        totalCash: 10000.0,
        lockedCash: 0.0
      }
    });
    portfolioId = portfolio.id;

    // 2. Forge JWT
    const secret = process.env.JWT_SECRET || 'fallback-secret-for-tests';
    userToken = jwt.sign({ sub: userId }, secret, { expiresIn: '1h' });

    // 3. Setup WebSocket client
    const address = httpServer.address() as import('net').AddressInfo;
    const port = address.port;
    clientSocket = ioc(`http://localhost:${port}`, {
      auth: { token: userToken }
    });

    await new Promise<void>((resolve) => {
      clientSocket!.on('connect', () => {
        clientSocket!.emit('join_portfolio', portfolioId);
        resolve();
      });
      clientSocket!.on('connect_error', (err) => {
        console.error('Socket connect_error', err);
        resolve(); // Or reject
      });
    });
  }, 30000);

  afterAll(async () => {
    if (originalMockTime !== undefined) process.env.MOCK_TIME = originalMockTime;
    else delete process.env.MOCK_TIME;
    
    if (originalJwtSecret !== undefined) process.env.JWT_SECRET = originalJwtSecret;
    else delete process.env.JWT_SECRET;

    if (clientSocket) {
      clientSocket.disconnect();
    }
    
    // Stop workers gracefully
    await prisma.$disconnect();
  });

  it('should autonomously process an order from ACCEPTED to FILLED', async () => {
    // We will listen for the WebSocket event indicating the order is completely processed
    const wsFilledPromise = new Promise<void>((resolve) => {
      clientSocket!.on('ORDER_FILLED', (envelope) => {
        if (envelope.payload.portfolioId === portfolioId) {
          resolve();
        }
      });
    });

    // 1. Submit REST Order
    const res = await request(app)
      .post('/api/orders')
      .set({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`,
        'Cookie': `token=${userToken}; csrf_token=test-csrf`,
        'x-csrf-token': 'test-csrf'
      })
      .send({
        portfolioId,
        symbol: 'RELIANCE',
        side: 'BUY',
        type: 'LIMIT',
        requestedQuantity: '10',
        limitPrice: '100.00',
        currentMarketPrice: '150.00',
        idempotencyKey: `e2e-${Date.now()}`
      });
    if (res.status !== 201) {
      console.error('Order creation failed:', res.body);
    }
    expect(res.status).toBe(201);
    const orderId = res.body.id;
    expect(res.body.status).toBe(OrderStatus.ACCEPTED);

    // Wait a brief moment for OutboxWorker and DomainEventDispatcher to route it
    await new Promise(r => setTimeout(r, 4000));

    // Verify DB transition
    const pendingOrder = await prisma.order.findUnique({ where: { id: orderId } });
    expect(pendingOrder?.status).toBe(OrderStatus.PENDING);

    // 2. Trigger execution via Market Simulator ticks (pushed manually)
    const ioredisClient = (tradingEngine as any).redis;
    
    // We will push ticks repeatedly because the TradingEngine reads the DB asynchronously
    // when it receives engine:route, and we might have pushed the tick before it was loaded into memory.
    let tickInterval: NodeJS.Timeout | undefined;
    const wsFilledPromise2 = new Promise<void>((resolve, reject) => {
      clientSocket!.on('ORDER_FILLED', (envelope: any) => {
        if (envelope.payload.orderId === orderId) {
          resolve();
        }
      });
    });

    try {
      tickInterval = setInterval(async () => {
        const price = 90.0; // Deterministic price to make math exact (Cost = 900)
        const timeNow = defaultTimeProvider.now();
        console.log(`[TEST TICK] NODE_ENV=${process.env.NODE_ENV}, MOCK_TIME=${process.env.MOCK_TIME}, time=${timeNow.toISOString()}`);
        await ioredisClient.publish(`market:tick:RELIANCE`, JSON.stringify({ symbol: 'RELIANCE', price, timestamp: timeNow }));
      }, 500);
      
      // Wait for outbox to route events (DomainEventDispatcherWorker -> Engine)
      // And for engine to publish ORDER_FILLED
      await Promise.race([
        wsFilledPromise2,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for ORDER_FILLED event')), 30000))
      ]);
    } finally {
      if (tickInterval) clearInterval(tickInterval);
    }

    // 3. Final Verification
    const filledOrder = await prisma.order.findUnique({ where: { id: orderId } });
    expect(filledOrder?.status).toBe(OrderStatus.FILLED);
    expect(filledOrder?.filledQuantity.toString()).toBe('10');

    // Verify Funds
    const updatedPortfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId } });
    // Cost = 10 * 90.05 = 900.5. Total should be 10000 - 900.5 = 9099.5
    expect(updatedPortfolio?.totalCash.toString()).toBe('9099.5');
    expect(updatedPortfolio?.lockedCash.toString()).toBe('0');

    // Verify Position
    const position = await prisma.position.findFirst({
      where: { portfolioId, symbol: 'RELIANCE' }
    });
    expect(position?.quantity.toString()).toBe('10');
  }, 45000);
});
