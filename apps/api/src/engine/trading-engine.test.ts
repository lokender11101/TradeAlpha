import { MarketSimulatorService } from '../services/market-simulator.service';
import { TradingEngine } from './trading-engine';
import { Order, OrderSide, OrderType, OrderStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

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

  beforeEach(() => {
    simulator = new MarketSimulatorService();
    engine = new TradingEngine('redis://localhost:6379', simulator);
  });

  afterEach(async () => {
    await engine.close();
  });

  const createTestOrder = (overrides: Partial<Order>): Order => ({
    id: randomUUID(),
    userId: randomUUID(),
    portfolioId: randomUUID(),
    symbol: 'AAPL',
    side: OrderSide.BUY,
    type: OrderType.LIMIT,
    requestedQuantity: new Prisma.Decimal(10),
    filledQuantity: new Prisma.Decimal(0),
    limitPrice: new Prisma.Decimal(150),
    stopPrice: null,
    reservationPrice: new Prisma.Decimal(150),
    status: OrderStatus.PENDING,
    idempotencyKey: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  });

  it('should immediately execute a MARKET order on the next tick', async () => {
    const order = createTestOrder({ type: OrderType.MARKET });
    engine.addOrder(order);

    simulator.pushTick('AAPL', 155.0); // push deterministic tick

    // Give microtasks time to resolve
    await new Promise(resolve => setImmediate(resolve));

    const executionQueue = (engine as any).executionQueue;
    expect(executionQueue.add).toHaveBeenCalledTimes(1);
    expect(executionQueue.add).toHaveBeenCalledWith(
      'EXECUTE_FILL',
      expect.objectContaining({
        orderId: order.id,
        price: expect.any(String),
        quantity: expect.any(String)
      }),
      expect.any(Object)
    );
  });

  it('should trigger LIMIT BUY only when tickPrice <= limitPrice', async () => {
    const order = createTestOrder({ side: OrderSide.BUY, limitPrice: new Prisma.Decimal(150) });
    engine.addOrder(order);

    simulator.pushTick('AAPL', 151.0);
    await new Promise(resolve => setImmediate(resolve));
    const executionQueue = (engine as any).executionQueue;
    expect(executionQueue.add).not.toHaveBeenCalled();

    simulator.pushTick('AAPL', 149.0);
    await new Promise(resolve => setImmediate(resolve));
    expect(executionQueue.add).toHaveBeenCalledTimes(1);
  });

  it('should trigger LIMIT SELL only when tickPrice >= limitPrice', async () => {
    const order = createTestOrder({ side: OrderSide.SELL, limitPrice: new Prisma.Decimal(150) });
    engine.addOrder(order);

    simulator.pushTick('AAPL', 149.0);
    await new Promise(resolve => setImmediate(resolve));
    const executionQueue = (engine as any).executionQueue;
    expect(executionQueue.add).not.toHaveBeenCalled();

    simulator.pushTick('AAPL', 151.0);
    await new Promise(resolve => setImmediate(resolve));
    expect(executionQueue.add).toHaveBeenCalledTimes(1);
  });

  it('should remove order from book after triggering execution', async () => {
    const order = createTestOrder({ type: OrderType.MARKET });
    engine.addOrder(order);

    simulator.pushTick('AAPL', 155.0);
    await new Promise(resolve => setImmediate(resolve));
    const executionQueue = (engine as any).executionQueue;
    expect(executionQueue.add).toHaveBeenCalledTimes(1);

    // Push second tick, should NOT trigger again
    simulator.pushTick('AAPL', 156.0);
    await new Promise(resolve => setImmediate(resolve));
    expect(executionQueue.add).toHaveBeenCalledTimes(1); // remains 1
  });

  it('should not trigger if fully filled', async () => {
    const order = createTestOrder({ type: OrderType.MARKET, requestedQuantity: new Prisma.Decimal(10), filledQuantity: new Prisma.Decimal(10) });
    engine.addOrder(order);

    simulator.pushTick('AAPL', 155.0);
    await new Promise(resolve => setImmediate(resolve));
    const executionQueue = (engine as any).executionQueue;
    expect(executionQueue.add).not.toHaveBeenCalled();
  });
});
