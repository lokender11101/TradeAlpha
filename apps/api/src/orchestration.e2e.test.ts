import request from 'supertest';
import { PrismaClient, OrderStatus } from '@prisma/client';
import { app, httpServer, wsServer, outboxWorker, executionWorker, domainEventDispatcher, simulator, tradingEngine, bootstrap } from './index';
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
    await bootstrap();
    // 1. Create a user and portfolio
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
    userToken = jwt.sign({ sub: userId }, process.env.JWT_SECRET || 'test-secret', { expiresIn: '1h' });

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
  }, 10000);

  afterAll(async () => {
    if (clientSocket) {
      clientSocket.disconnect();
    }
    
    // Stop workers gracefully
    await outboxWorker?.stop();
    await executionWorker?.close();
    await domainEventDispatcher?.close();
    simulator?.stopAll();
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
      .set('Authorization', `Bearer ${userToken}`)
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
    // The TradingEngine should pick it up and set it to PENDING.
    await new Promise(r => setTimeout(r, 2000));

    // Verify DB transition
    const pendingOrder = await prisma.order.findUnique({ where: { id: orderId } });
    expect(pendingOrder?.status).toBe(OrderStatus.PENDING);

    // 2. Trigger execution via Market Simulator
    // (This triggers TradingEngine which queues EXECUTE_FILL for ExecutionWorker)
    simulator.pushTick('AAPL', 149.0);

    // Wait for the full lifecycle to complete via WebSocket event
    // BullMQ execution worker processes the fill, writes to Ledger, outbox sends ORDER_FILLED.
    await Promise.race([
      wsFilledPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for ORDER_FILLED event')), 10000))
    ]);

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
  }, 15000);
});
