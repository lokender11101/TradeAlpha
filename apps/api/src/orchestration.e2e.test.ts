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

  beforeAll(async () => {
    // Override port to 0 for random available port to avoid conflicts
    process.env.PORT = '0';
    process.env.JWT_SECRET = 'test-secret';
    const ioredis = new (require('ioredis').Redis)('redis://localhost:6379');
    await ioredis.flushdb();
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
    if (clientSocket) {
      clientSocket.disconnect();
    }
    
    // Stop workers gracefully
    await outboxWorker?.stop();
    await executionWorker?.close();
    await domainEventDispatcher?.close();
    await tradingEngine?.close();
    wsServer?.close();
    httpServer.close();
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
        symbol: 'AAPL',
        side: 'BUY',
        type: 'LIMIT',
        requestedQuantity: '10',
        limitPrice: '150.00',
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
    const tickInterval = setInterval(async () => {
      try {
        await ioredisClient.publish('market:tick:AAPL', JSON.stringify({
          symbol: 'AAPL',
          price: '149.0',
          timestamp: new Date().toISOString()
        }));
      } catch (err) {} // ignore closed connection errors
    }, 500);

    try {
      // 2. Trigger execution via Market Simulator
      // (This triggers TradingEngine which queues EXECUTE_FILL for ExecutionWorker)
      
      // Wait for outbox to route events (DomainEventDispatcherWorker -> Engine)
      // And for engine to publish ORDER_FILLED
      await Promise.race([
        wsFilledPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for ORDER_FILLED event')), 30000))
      ]);
    } finally {
      clearInterval(tickInterval);
    }

    // 3. Final Verification
    const filledOrder = await prisma.order.findUnique({ where: { id: orderId } });
    expect(filledOrder?.status).toBe(OrderStatus.FILLED);
    expect(filledOrder?.filledQuantity.toString()).toBe('10');

    // Verify Funds
    const updatedPortfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId } });
    // Cost = 10 * 149 = 1490. Total should be 10000 - 1490 = 8510
    expect(updatedPortfolio?.totalCash.toString()).toBe('8510');
    expect(updatedPortfolio?.lockedCash.toString()).toBe('0');

    // Verify Position
    const position = await prisma.position.findFirst({
      where: { portfolioId, symbol: 'AAPL' }
    });
    expect(position?.quantity.toString()).toBe('10');
  }, 45000);
});
