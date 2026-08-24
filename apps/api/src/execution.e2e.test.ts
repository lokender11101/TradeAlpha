import request from 'supertest';
import { PrismaClient, OrderStatus } from '@prisma/client';
import { app, httpServer, wsServer } from './main.api';
import { TradingEngine } from './engine/trading-engine';
import { OrderService } from './services/order.service';
import { PriceCacheService } from './services/price-cache.service';
import { OutboxWorker } from './workers/outbox.worker';
import { ExecutionWorker } from './workers/execution.worker';
import { DomainEventDispatcherWorker } from './workers/domain-event-dispatcher.worker';

import jwt from 'jsonwebtoken';
import { defaultTimeProvider } from './services/time.provider';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

describe('Phase 6.3 Execution Realism E2E', () => {
  let userToken: string;
  let userId: string;
  let portfolioId: string;
  let redis: import('ioredis').Redis;
  let tradingEngine: TradingEngine;
  let outboxWorker: OutboxWorker;
  let executionWorker: ExecutionWorker;
  let domainEventDispatcher: DomainEventDispatcherWorker;

  beforeAll(async () => {
    // Override port to 0 for random available port to avoid conflicts
    process.env.MOCK_TIME = 'true';
    process.env.PORT = '0';
    process.env.JWT_SECRET = 'test-secret';
    redis = new (require('ioredis').Redis)('redis://localhost:6379', { maxRetriesPerRequest: null });
    await redis.flushdb();
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "outbox_events", "orders", "order_fills", "positions", "portfolios", "users" CASCADE');
    
    const orderService = new OrderService(prisma);
    const priceCacheService = new PriceCacheService(redis);
    tradingEngine = new TradingEngine(process.env.REDIS_URL || 'redis://localhost:6379', prisma, orderService, priceCacheService, ['RELIANCE', 'TCS']);
    outboxWorker = new OutboxWorker(prisma, process.env.REDIS_URL || 'redis://localhost:6379');
    executionWorker = new ExecutionWorker(prisma, process.env.REDIS_URL || 'redis://localhost:6379');
    domainEventDispatcher = new DomainEventDispatcherWorker(process.env.REDIS_URL || 'redis://localhost:6379', orderService);

    await tradingEngine.start();
    await outboxWorker.start(200);
    // executionWorker and domainEventDispatcher started
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    
    const user = await prisma.user.create({
      data: {
        email: `test-${Date.now()}@example.com`,
        passwordHash: 'hash'
      }
    });
    userId = user.id;

    // Use Ledger transaction to fund exactly like the real flow
    const portfolio = await prisma.portfolio.create({
      data: { userId }
    });
    portfolioId = portfolio.id;
    
    await prisma.$executeRaw`UPDATE portfolios SET total_cash = 1000000 WHERE id = ${portfolioId}`;
    await prisma.position.create({
      data: {
        portfolioId,
        symbol: 'RELIANCE',
        quantity: 5000,
        averageEntryPrice: 100
      }
    });

    // Forge JWT
    const secret = process.env.JWT_SECRET || 'fallback-secret-for-tests';
    userToken = jwt.sign({ sub: userId }, secret, { expiresIn: '1h' });
  });

  afterAll(async () => {
    await outboxWorker.stop();
    await executionWorker.close();
    await domainEventDispatcher.close();
    await tradingEngine.close();
    await redis.quit();
    await prisma.$disconnect();
    delete process.env.MOCK_TIME;
    delete process.env.JWT_SECRET;
  });

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // Push a deterministic tick directly to redis
  const pushTick = async (symbol: string, price: string) => {
    const tick = {
      tickId: crypto.randomUUID(),
      symbol,
      price,
      volume: '100',
      timestamp: defaultTimeProvider.now()
    };
    await redis.publish(`market:tick:${symbol}`, JSON.stringify(tick));
    await redis.hset('prices:latest', symbol, JSON.stringify(tick));
  };

  it('1. Spread and Slippage - BUY MARKET order partial fills (deterministic multi-tick)', async () => {
    // RELIANCE Profile: spread=0.10, depth=500, slippage=0.05
    await pushTick('RELIANCE', '150.00'); // set reference price
    
    const placeRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Cookie', `token=${userToken}; csrf_token=test-csrf`)
      .set('x-csrf-token', 'test-csrf')
      .send({
        portfolioId,
        symbol: 'RELIANCE',
        side: 'BUY',
        type: 'MARKET',
        requestedQuantity: '1200',
        currentMarketPrice: '150.00',
        idempotencyKey: crypto.randomUUID()
      });
      
    expect(placeRes.status).toBe(201);
    const orderId = placeRes.body.id;

    await sleep(2000);

    // Tick 2: refPrice=150.00, filled=0
    // BUY L0 Ask = 150.00 + 0.10/2 = 150.05
    await pushTick('RELIANCE', '150.00');
    await sleep(2000); // Allow worker -> dispatcher -> engine:route -> READY

    let order = await prisma.order.findUnique({ where: { id: orderId }, include: { fills: true } });
    expect(order?.status).toBe(OrderStatus.PARTIALLY_FILLED);
    expect(order?.filledQuantity.toString()).toBe('500');
    expect(Number(order?.fills[0].price.toString()).toFixed(2)).toBe('150.05');
    expect(order?.fills[0].executionIdempotencyKey).toBe(`exec_${orderId}_500`);

    // Tick 3: refPrice=150.00, filled=500 (level 1)
    // BUY L1 Ask = 150.05 + 0.05(slippage) = 150.10
    await pushTick('RELIANCE', '150.00');
    await sleep(2000);

    order = await prisma.order.findUnique({ where: { id: orderId }, include: { fills: true } });
    expect(order?.status).toBe(OrderStatus.PARTIALLY_FILLED);
    expect(order?.filledQuantity.toString()).toBe('1000');
    const f2 = order?.fills.find((f: any) => f.quantity.toString() === '500' && Number(f.price.toString()).toFixed(2) === '150.10');
    expect(f2).toBeDefined();
    expect(f2?.executionIdempotencyKey).toBe(`exec_${orderId}_1000`);

    // Tick 4: refPrice=150.00, filled=1000 (level 2)
    // BUY L2 Ask = 150.05 + 0.10(slippage) = 150.15
    await pushTick('RELIANCE', '150.00');
    await sleep(2000);

    order = await prisma.order.findUnique({ where: { id: orderId }, include: { fills: true } });
    expect(order?.status).toBe(OrderStatus.FILLED);
    expect(order?.filledQuantity.toString()).toBe('1200');
    const f3 = order?.fills.find((f: any) => f.quantity.toString() === '200');
    expect(Number(f3?.price.toString()).toFixed(2)).toBe('150.15');
    expect(f3?.executionIdempotencyKey).toBe(`exec_${orderId}_1200`);
  }, 30000);

  it('2. Strict LIMIT Re-evaluation - Violates on later level', async () => {
    // RELIANCE Profile: spread=0.10, depth=500, slippage=0.05
    // LIMIT BUY 1200 @ 150.12
    await pushTick('RELIANCE', '150.00');
    
    const placeRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Cookie', `token=${userToken}; csrf_token=test-csrf`)
      .set('x-csrf-token', 'test-csrf')
      .send({
        portfolioId,
        symbol: 'RELIANCE',
        side: 'BUY',
        type: 'LIMIT',
        requestedQuantity: '1200',
        limitPrice: '150.12',
        currentMarketPrice: '150.00',
        idempotencyKey: crypto.randomUUID()
      });
      
    expect(placeRes.status).toBe(201);
    const orderId = placeRes.body.id;
    await sleep(2000);

    // Tick 1: refPrice=150.00, Ask=150.05 <= 150.12. Fills 500 @ 150.05
    await pushTick('RELIANCE', '150.00');
    await sleep(2000);

    let state: any = await prisma.order.findUnique({ where: { id: orderId }, include: { fills: true } });
    expect(state?.status).toBe(OrderStatus.PARTIALLY_FILLED);
    expect(state?.filledQuantity.toString()).toBe('500');

    // Tick 2: refPrice=150.00, Ask=150.05, level=1 -> executable = 150.10 <= 150.12. Fills 500 @ 150.10
    await pushTick('RELIANCE', '150.00');
    await sleep(2000);

    state = await prisma.order.findUnique({ where: { id: orderId } });
    expect(state?.filledQuantity.toString()).toBe('1000');

    // Tick 3: refPrice=150.00, Ask=150.05, level=2 -> executable = 150.15 > 150.12! Should NOT fill.
    await pushTick('RELIANCE', '150.00');
    await sleep(2000);

    state = await prisma.order.findUnique({ where: { id: orderId } });
    expect(state?.filledQuantity.toString()).toBe('1000'); // Remains 1000
    expect(state?.status).toBe(OrderStatus.PARTIALLY_FILLED); // Remains partially filled!

    // Tick 4: refPrice=149.90, Ask=149.95, level=2 -> executable = 149.95+0.10=150.05 <= 150.12! Should fill remaining 200.
    await pushTick('RELIANCE', '149.90');
    await sleep(2000);

    state = await prisma.order.findUnique({ where: { id: orderId } });
    expect(state?.filledQuantity.toString()).toBe('1200');
    expect(state?.status).toBe(OrderStatus.FILLED);
  }, 30000);
  
  it('3. Duplicate QUEUED safety and Identical dispatch suppression', async () => {
    await pushTick('RELIANCE', '160.00');

    const placeRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Cookie', `token=${userToken}; csrf_token=test-csrf`)
      .set('x-csrf-token', 'test-csrf')
      .send({
        portfolioId,
        symbol: 'RELIANCE',
        side: 'SELL',
        type: 'MARKET',
        requestedQuantity: '500', // Matches exact depth
        currentMarketPrice: '160.00',
        idempotencyKey: crypto.randomUUID()
      });
      
    expect(placeRes.status).toBe(201);
    const orderId = placeRes.body.id;
    await sleep(2000);
    
    await pushTick('RELIANCE', '160.00');
    // Immediately bombard with spoofed engine:routes BEFORE the worker finishes!
    for (let i=0; i<5; i++) {
      await redis.publish('engine:route:RELIANCE', JSON.stringify({ orderId, symbol: 'RELIANCE' }));
    }
    
    await sleep(2000); // Allow worker to finish
    
    const state = await prisma.order.findUnique({ where: { id: orderId }, include: { fills: true } });
    expect(state?.status).toBe(OrderStatus.FILLED);
    expect(state?.filledQuantity.toString()).toBe('500');
    expect(state?.fills).toHaveLength(1); // EXACTLY ONE FILL (Idempotent database insert rejected the rest, but engine didn't even queue them)
  }, 30000);
  it('4. SELL Execution Realism - spread, slippage, multi-tick', async () => {
    // RELIANCE Profile: spread=0.10, depth=500, slippage=0.05
    await pushTick('RELIANCE', '150.00'); // set reference price
    
    const placeRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Cookie', `token=${userToken}; csrf_token=test-csrf`)
      .set('x-csrf-token', 'test-csrf')
      .send({
        portfolioId,
        symbol: 'RELIANCE',
        side: 'SELL',
        type: 'MARKET',
        requestedQuantity: '1200',
        currentMarketPrice: '150.00',
        idempotencyKey: crypto.randomUUID()
      });
      
    expect(placeRes.status).toBe(201);
    const orderId = placeRes.body.id;
    await sleep(2000);

    // Tick 1: refPrice=150.00
    // SELL L0 Bid = 150.00 - 0.10/2 = 149.95
    await pushTick('RELIANCE', '150.00');
    await sleep(2000);

    let order = await prisma.order.findUnique({ where: { id: orderId }, include: { fills: true } });
    expect(order?.status).toBe(OrderStatus.PARTIALLY_FILLED);
    expect(order?.filledQuantity.toString()).toBe('500');
    expect(Number(order?.fills[0].price.toString()).toFixed(2)).toBe('149.95');

    // Tick 2: level 1, slippage 0.05 -> 149.90
    await pushTick('RELIANCE', '150.00');
    await sleep(2000);

    order = await prisma.order.findUnique({ where: { id: orderId }, include: { fills: true } });
    expect(order?.filledQuantity.toString()).toBe('1000');
    const f2 = order?.fills.find((f: any) => f.quantity.toString() === '500' && Number(f.price.toString()).toFixed(2) === '149.90');
    expect(f2).toBeDefined();

    // Tick 3: level 2, slippage 0.10 -> 149.85
    await pushTick('RELIANCE', '150.00');
    await sleep(2000);

    order = await prisma.order.findUnique({ where: { id: orderId }, include: { fills: true } });
    expect(order?.status).toBe(OrderStatus.FILLED);
    expect(order?.filledQuantity.toString()).toBe('1200');
    const f3 = order?.fills.find((f: any) => f.quantity.toString() === '200');
    expect(Number(f3?.price.toString()).toFixed(2)).toBe('149.85');
    expect(f3?.executionIdempotencyKey).toBe(`exec_${orderId}_1200`);
  }, 30000);

  it('5. STOP execution preserves determinism and new depth logic', async () => {
    const placeRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Cookie', `token=${userToken}; csrf_token=test-csrf`)
      .set('x-csrf-token', 'test-csrf')
      .send({
        portfolioId,
        symbol: 'RELIANCE',
        side: 'BUY',
        type: 'STOP',
        requestedQuantity: '600',
        stopPrice: '155.00',
        currentMarketPrice: '150.00',
        idempotencyKey: crypto.randomUUID()
      });
      
    expect(placeRes.status).toBe(201);
    const orderId = placeRes.body.id;
    await sleep(2000);
    
    // Not triggered yet
    await pushTick('RELIANCE', '154.00');
    await sleep(2000);
    let state: any = await prisma.order.findUnique({ where: { id: orderId }, include: { fills: true } });
    expect(state?.status).toBe(OrderStatus.PENDING);

    // Trigger STOP!
    await pushTick('RELIANCE', '155.00');
    await sleep(2000);
    state = await prisma.order.findUnique({ where: { id: orderId } });
    expect(state?.status).toBe(OrderStatus.PARTIALLY_FILLED);
    expect(state?.filledQuantity.toString()).toBe('500'); // 500 @ 155.05

    // Tick 2: remaining 100 @ 155.10
    await pushTick('RELIANCE', '155.00');
    await sleep(2000);
    state = await prisma.order.findUnique({ where: { id: orderId }, include: { fills: true } });
    expect(state?.status).toBe(OrderStatus.FILLED);
    expect(state?.filledQuantity.toString()).toBe('600');
    expect(state?.fills.length).toBe(2);
    expect(state?.fills[1].executionIdempotencyKey).toBe(`exec_${orderId}_600`);
  }, 30000);

  it('6. STOP_LIMIT execution persistent activation', async () => {
    const placeRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Cookie', `token=${userToken}; csrf_token=test-csrf`)
      .set('x-csrf-token', 'test-csrf')
      .send({
        portfolioId,
        symbol: 'RELIANCE',
        side: 'SELL',
        type: 'STOP_LIMIT',
        requestedQuantity: '600',
        stopPrice: '145.00',
        limitPrice: '144.90',
        currentMarketPrice: '150.00',
        idempotencyKey: crypto.randomUUID()
      });
      
    expect(placeRes.status).toBe(201);
    const orderId = placeRes.body.id;
    await sleep(2000);
    
    // Activate STOP_LIMIT (Sell triggers when tick <= 145.00)
    await pushTick('RELIANCE', '145.00');
    await sleep(2000);
    let state: any = await prisma.order.findUnique({ where: { id: orderId }, include: { fills: true } });
    // First tick activates and then evaluates as LIMIT. 
    // Tick=145.00. Bid=144.95. limit=144.90. 144.95 >= 144.90 => Executable!
    expect(state?.isActivated).toBe(true);
    expect(state?.status).toBe(OrderStatus.PARTIALLY_FILLED);
    expect(state?.filledQuantity.toString()).toBe('500'); // Fills 500 @ 144.95

    // Tick 2: ref=145.00. Level=1, slippage=0.05. Bid=144.90. limit=144.90 => Executable!
    await pushTick('RELIANCE', '145.00');
    await sleep(2000);
    state = await prisma.order.findUnique({ where: { id: orderId } });
    expect(state?.status).toBe(OrderStatus.FILLED);
    expect(state?.filledQuantity.toString()).toBe('600'); // Fills 100 @ 144.90
  }, 30000);

  it('7. Engine Restart between partial fills recovers state safely', async () => {
    const placeRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Cookie', `token=${userToken}; csrf_token=test-csrf`)
      .set('x-csrf-token', 'test-csrf')
      .send({
        portfolioId,
        symbol: 'RELIANCE',
        side: 'BUY',
        type: 'MARKET',
        requestedQuantity: '1000',
        currentMarketPrice: '150.00',
        idempotencyKey: crypto.randomUUID()
      });
    const orderId = placeRes.body.id;
    await sleep(2000);
    
    await pushTick('RELIANCE', '150.00');
    await sleep(2000);
    
    let order: any = await prisma.order.findUnique({ where: { id: orderId }, include: { fills: true } });
    expect(order?.status).toBe(OrderStatus.PARTIALLY_FILLED);
    expect(order?.filledQuantity.toString()).toBe('500');

    // Simulate engine restart!
    tradingEngine["orders"].clear(); await tradingEngine.hydrate();

    await pushTick('RELIANCE', '150.00');
    await sleep(2000);
    order = await prisma.order.findUnique({ where: { id: orderId }, include: { fills: true } });
    expect(order?.status).toBe(OrderStatus.FILLED);
    expect(order?.filledQuantity.toString()).toBe('1000');
    
    // Check no duplicate execution idempotency keys
    expect(order?.fills.length).toBe(2);
    expect(order?.fills.find((f: any) => f.quantity.toString() === "500" && f.executionIdempotencyKey === `exec_${orderId}_1000`)).toBeDefined(); // (`exec_${orderId}_1000`);
  }, 30000);

  it('8. Session Fence Edge Cases (Worker Rejection)', async () => {
    // Manually add an EXECUTE_FILL job to executionWorker queue with an invalid originTimestamp
    const { Queue } = require('bullmq');
    const q = new Queue('tradealpha-execution', { connection: redis });
    const orderId = crypto.randomUUID();
    await prisma.order.create({
      data: {
        id: orderId,
        portfolioId,
        symbol: 'RELIANCE',
        type: 'MARKET',
        side: 'BUY',
        requestedQuantity: 10,
        filledQuantity: 0,
        status: 'PENDING', userId, idempotencyKey: crypto.randomUUID(),
      }
    });

    // Send tick from CLOSED session (e.g. 19:41 UTC)
    await q.add('EXECUTE_FILL', {
      orderId,
      price: '150.05',
      quantity: '10',
      executionIdempotencyKey: `exec_${orderId}_10`,
      correlationId: 'test',
      originTimestamp: '2026-08-23T19:41:38.987Z'
    });

    await sleep(2000);
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('PENDING'); // It was rejected by worker!
  });
});
