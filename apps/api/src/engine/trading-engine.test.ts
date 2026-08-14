import { MarketSimulatorService } from '../services/market-simulator.service';
import { TradingEngine } from './trading-engine';
import { Order, OrderSide, OrderType, OrderStatus, Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { OrderService } from '../services/order.service';

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    close: jest.fn(),
  })),
}));

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    quit: jest.fn(),
  }));
});

describe('TradingEngine', () => {
  let simulator: MarketSimulatorService;
  let engine: TradingEngine;
  let mockPrisma: any;
  let mockOrderService: any;

  beforeEach(() => {
    simulator = new MarketSimulatorService();
    
    mockPrisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
      }
    };

    mockOrderService = {
      activateStopLimit: jest.fn(),
    };

    engine = new TradingEngine('redis://localhost:6379', simulator, mockPrisma as any, mockOrderService as any);
  });

  afterEach(async () => {
    await engine.close();
  });

  const createTestOrder = (overrides: Partial<Order>): Order => ({
    id: overrides.id || randomUUID(),
    userId: randomUUID(),
    portfolioId: randomUUID(),
    symbol: 'AAPL',
    side: OrderSide.BUY,
    type: OrderType.LIMIT,
    requestedQuantity: new Prisma.Decimal(10),
    filledQuantity: new Prisma.Decimal(0),
    limitPrice: overrides.limitPrice ? new Prisma.Decimal(overrides.limitPrice as any) : null,
    stopPrice: overrides.stopPrice ? new Prisma.Decimal(overrides.stopPrice as any) : null,
    reservationPrice: new Prisma.Decimal(150),
    status: overrides.status || OrderStatus.PENDING,
    idempotencyKey: randomUUID(),
    isActivated: overrides.isActivated || false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  });

  describe('Duplicate Execution Protection (In-Memory Guard)', () => {
    it('should queue only 1 EXECUTE_FILL job even if 10 matching ticks arrive', async () => {
      const order = createTestOrder({ type: OrderType.MARKET });
      engine.addOrder(order);

      // Fire 10 ticks synchronously
      for (let i = 0; i < 10; i++) {
        simulator.pushTick('AAPL', 155.0);
      }

      await new Promise(resolve => setImmediate(resolve));

      const executionQueue = (engine as any).executionQueue;
      expect(executionQueue.add).toHaveBeenCalledTimes(1);

      // Check deterministic jobId
      const expectedJobId = `exec_${order.id}_0`;
      expect(executionQueue.add).toHaveBeenCalledWith(
        'EXECUTE_FILL',
        expect.anything(),
        expect.objectContaining({ jobId: expectedJobId })
      );
    });
  });

  describe('STOP Semantics', () => {
    it('should trigger STOP BUY when tickPrice >= stopPrice', async () => {
      const order = createTestOrder({ type: OrderType.STOP, side: OrderSide.BUY, stopPrice: new Prisma.Decimal(150) });
      engine.addOrder(order);

      simulator.pushTick('AAPL', 149.0);
      await new Promise(resolve => setImmediate(resolve));
      const executionQueue = (engine as any).executionQueue;
      expect(executionQueue.add).not.toHaveBeenCalled();

      simulator.pushTick('AAPL', 150.0);
      await new Promise(resolve => setImmediate(resolve));
      expect(executionQueue.add).toHaveBeenCalledTimes(1);
    });

    it('should trigger STOP SELL when tickPrice <= stopPrice', async () => {
      const order = createTestOrder({ type: OrderType.STOP, side: OrderSide.SELL, stopPrice: new Prisma.Decimal(150) });
      engine.addOrder(order);

      simulator.pushTick('AAPL', 151.0);
      await new Promise(resolve => setImmediate(resolve));
      const executionQueue = (engine as any).executionQueue;
      expect(executionQueue.add).not.toHaveBeenCalled();

      simulator.pushTick('AAPL', 150.0);
      await new Promise(resolve => setImmediate(resolve));
      expect(executionQueue.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('STOP_LIMIT Semantics', () => {
    it('should activate STOP_LIMIT precisely once and persist via DB', async () => {
      const order = createTestOrder({ 
        type: OrderType.STOP_LIMIT, 
        side: OrderSide.BUY, 
        stopPrice: new Prisma.Decimal(150),
        limitPrice: new Prisma.Decimal(155),
        isActivated: false
      });
      engine.addOrder(order);

      // Mock the successful DB activation
      mockOrderService.activateStopLimit.mockResolvedValue({ ...order, isActivated: true });

      // Tick crosses stopPrice but not limitPrice (so it activates, but doesn't fill)
      // Wait, limit BUY fills when tick <= limit.
      // 150 crosses stop (150). 150 <= limit (155). It will fill immediately if we push 150.
      // Let's push 156. tick >= stop (156 >= 150), so it activates. tick <= limit is false (156 <= 155), so no fill.
      simulator.pushTick('AAPL', 156.0);
      await new Promise(resolve => setImmediate(resolve));

      expect(mockOrderService.activateStopLimit).toHaveBeenCalledTimes(1);
      const executionQueue = (engine as any).executionQueue;
      expect(executionQueue.add).not.toHaveBeenCalled();

      // Next tick, price drops to limit (155)
      simulator.pushTick('AAPL', 155.0);
      await new Promise(resolve => setImmediate(resolve));
      
      // Should fill, and activate should NOT be called again
      expect(mockOrderService.activateStopLimit).toHaveBeenCalledTimes(1);
      expect(executionQueue.add).toHaveBeenCalledTimes(1);
    });

    it('should not double-activate if multiple ticks cross the stop price', async () => {
      const order = createTestOrder({ 
        type: OrderType.STOP_LIMIT, 
        side: OrderSide.BUY, 
        stopPrice: new Prisma.Decimal(150),
        limitPrice: new Prisma.Decimal(155),
        isActivated: false
      });
      engine.addOrder(order);

      mockOrderService.activateStopLimit.mockResolvedValue({ ...order, isActivated: true });

      simulator.pushTick('AAPL', 156.0);
      simulator.pushTick('AAPL', 157.0); // second tick while activation is in progress
      
      await new Promise(resolve => setImmediate(resolve));

      // Depending on the race condition between ticks and the DB call, the engine state should correctly update.
      // Because Node is single threaded, evaluateOrder is synchronous up to the `await this.orderService.activateStopLimit`.
      // If we await it, the next tick is processed after.
      expect(mockOrderService.activateStopLimit).toHaveBeenCalledTimes(1);
    });

    it('should behave as LIMIT immediately if loaded with isActivated = true', async () => {
      const order = createTestOrder({ 
        type: OrderType.STOP_LIMIT, 
        side: OrderSide.BUY, 
        stopPrice: new Prisma.Decimal(150),
        limitPrice: new Prisma.Decimal(155),
        isActivated: true // SURVIVED RESTART
      });
      engine.addOrder(order);

      // It is already active. A price of 154 should fill immediately (154 <= 155)
      // even if it never crossed the stop (154 < 150).
      simulator.pushTick('AAPL', 154.0);
      await new Promise(resolve => setImmediate(resolve));

      expect(mockOrderService.activateStopLimit).not.toHaveBeenCalled();
      const executionQueue = (engine as any).executionQueue;
      expect(executionQueue.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('Hydration & Reconciliation', () => {
    it('should load PENDING and PARTIALLY_FILLED orders during hydration', async () => {
      const order1 = createTestOrder({ status: OrderStatus.PENDING });
      const order2 = createTestOrder({ status: OrderStatus.PARTIALLY_FILLED, requestedQuantity: new Prisma.Decimal(10), filledQuantity: new Prisma.Decimal(5) });
      const order3 = createTestOrder({ status: OrderStatus.FILLED, requestedQuantity: new Prisma.Decimal(10), filledQuantity: new Prisma.Decimal(10) });

      mockPrisma.order.findMany.mockResolvedValue([order1, order2, order3]);

      await engine.hydrate();

      const symbolBook = (engine as any).orders.get('AAPL');
      expect(symbolBook).toBeDefined();
      expect(symbolBook.has(order1.id)).toBe(true);
      expect(symbolBook.has(order2.id)).toBe(true);
      expect(symbolBook.has(order3.id)).toBe(false); // FILLED has remainingQty == 0, so excluded
    });

    it('should recover orphaned orders during reconciliation without altering existing QUEUED state', async () => {
      const order1 = createTestOrder({ id: '1', type: OrderType.MARKET });
      
      engine.addOrder(order1);
      
      // Simulate matching tick -> changes state to QUEUED
      simulator.pushTick('AAPL', 150.0);
      await new Promise(resolve => setImmediate(resolve));
      
      const stateBefore = (engine as any).orders.get('AAPL').get('1').state;
      expect(stateBefore).toBe('QUEUED');

      // Now run reconciliation. The DB still says PENDING (since execution takes time)
      const order2 = createTestOrder({ id: '2', status: OrderStatus.PENDING }); // A new orphaned order
      mockPrisma.order.findMany.mockResolvedValue([order1, order2]);

      await (engine as any).reconcile();

      // order1 should still be QUEUED, NOT reverted to READY
      const stateAfter = (engine as any).orders.get('AAPL').get('1').state;
      expect(stateAfter).toBe('QUEUED');

      // order2 should be loaded as READY
      expect((engine as any).orders.get('AAPL').has('2')).toBe(true);
      expect((engine as any).orders.get('AAPL').get('2').state).toBe('READY');
    });
  });
});
