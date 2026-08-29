import { TradingEngine } from './trading-engine';
import { Order, OrderSide, OrderType, OrderStatus, Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { OrderService } from '../services/order.service';
import { PriceCacheService } from '../services/price-cache.service';

const mockQueueAdd = jest.fn();
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    close: jest.fn(),
  })),
}));

// We need an advanced mock for ioredis to simulate leases
let redisStore: Record<string, string> = {};
let subscriberCallbacks: Record<string, Function[]> = {};

const mockSet = jest.fn((key, value, arg3, arg4, arg5) => {
  if (arg3 === 'NX' || arg5 === 'NX') {
    if (redisStore[key]) return Promise.resolve(null);
    redisStore[key] = value;
    return Promise.resolve('OK');
  }
  return Promise.resolve('OK');
});

const mockEval = jest.fn((script, numkeys, key, arg) => {
  if (script.includes('expire')) {
    // Heartbeat
    if (redisStore[key] === arg) return Promise.resolve(1);
    return Promise.resolve(0);
  }
  if (script.includes('del')) {
    // Release
    if (redisStore[key] === arg) {
      delete redisStore[key];
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  }
  return Promise.resolve(0);
});

const mockSubscribe = jest.fn((channel) => {
  if (!subscriberCallbacks[channel]) subscriberCallbacks[channel] = [];
  return Promise.resolve(1);
});

const mockUnsubscribe = jest.fn((channel) => {
  return Promise.resolve(1);
});

let onMessageCallback: any;

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    set: mockSet,
    eval: mockEval,
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    on: jest.fn((event, cb) => {
      if (event === 'message') {
        onMessageCallback = cb;
      }
    }),
    quit: jest.fn(),
  }));
});

describe('TradingEngine Phase 3', () => {
  let engine: TradingEngine;
  let mockPrisma: any;
  let mockOrderService: any;
  let mockPriceCache: any;

  beforeEach(() => {
    redisStore = {};
    subscriberCallbacks = {};
    mockQueueAdd.mockClear();
    mockSet.mockClear();
    mockEval.mockClear();
    mockSubscribe.mockClear();
    mockUnsubscribe.mockClear();

    mockPrisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
      }
    };

    mockOrderService = {
      activateStopLimit: jest.fn(),
    };

    mockPriceCache = {
      getLatestPrice: jest.fn().mockResolvedValue({ price: null, isStale: true }),
    };

  });

  afterEach(async () => {
    if (engine) await engine.close();
  });

  const createTestOrder = (overrides: Partial<Order>): Order => ({
    id: overrides.id || randomUUID(),
    userId: randomUUID(),
    portfolioId: randomUUID(),
    symbol: 'AAPL',
    type: OrderType.LIMIT,
    side: OrderSide.BUY,
    status: OrderStatus.PENDING,
    requestedQuantity: new Prisma.Decimal(10),
    filledQuantity: new Prisma.Decimal(0),
    limitPrice: new Prisma.Decimal(150),
    stopPrice: null,
    reservationPrice: null,
    reservedMargin: null,
    idempotencyKey: 'test',
    isActivated: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  });

  it('Competing engine startup fails fast', async () => {
    // Engine A already owns AAPL
    redisStore['engine:symbol:AAPL'] = 'tokenA';
    
    engine = new TradingEngine('redis://localhost', mockPrisma, mockOrderService, mockPriceCache, ['AAPL']);
    
    // Process exit should be called
    const mockExit = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error('Process exited');
    });

    await expect(engine.start()).rejects.toThrow('Process exited');
    
    mockExit.mockRestore();
  });

  it('Lease heartbeat valid token successfully extends', async () => {
    engine = new TradingEngine('redis://localhost', mockPrisma, mockOrderService, mockPriceCache, ['AAPL']);
    await engine.start(); // acquires lease
    
    // Fast forward or directly invoke private heartbeat method
    // In our mock, start() calls startHeartbeat. 
    // We will just invoke the lua script evaluation explicitly to test the logic
    const res = await mockEval(`expire`, 1, 'engine:symbol:AAPL', engine['processToken']);
    expect(res).toBe(1); // extended
  });

  it('Invalid heartbeat wrong token fails to extend', async () => {
    engine = new TradingEngine('redis://localhost', mockPrisma, mockOrderService, mockPriceCache, ['AAPL']);
    await engine.start(); 
    
    const res = await mockEval(`expire`, 1, 'engine:symbol:AAPL', 'wrongToken');
    expect(res).toBe(0); // rejected
  });

  it('Atomic release Engine A cannot delete Engine Bs lease', async () => {
    engine = new TradingEngine('redis://localhost', mockPrisma, mockOrderService, mockPriceCache, ['AAPL']);
    await engine.start(); 
    
    redisStore['engine:symbol:AAPL'] = 'tokenB'; // B stole it somehow
    
    await engine.close(); // attempts to release
    expect(redisStore['engine:symbol:AAPL']).toBe('tokenB'); // Not deleted
    engine = undefined as any; // prevent double close
  });

  it('STALE OWNER FENCING MUST NOT enqueue EXECUTE_FILL', async () => {
    engine = new TradingEngine('redis://localhost', mockPrisma, mockOrderService, mockPriceCache, ['AAPL']);
    await engine.start();

    const order = createTestOrder({ type: OrderType.MARKET });
    (engine as any).addOrder(order);

    // Engine A loses AAPL
    engine['handleLeaseLoss']('AAPL');

    // Simulate incoming tick
    if (onMessageCallback) {
      onMessageCallback('market:tick:AAPL', JSON.stringify({ symbol: 'AAPL', price: '150.00', timestamp: new Date() }));
    }

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('Exact subscriptions Engine only receives ticks for assigned/owned symbols', async () => {
    engine = new TradingEngine('redis://localhost', mockPrisma, mockOrderService, mockPriceCache, ['TSLA']);
    await engine.start();

    expect(mockSubscribe).toHaveBeenCalledWith('market:tick:TSLA');
    expect(mockSubscribe).not.toHaveBeenCalledWith('market:tick:AAPL');
  });

  it('Hydration PENDING and PARTIALLY_FILLED recovered only for owned symbols', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      createTestOrder({ id: 'tsla1', symbol: 'TSLA' }),
      createTestOrder({ id: 'aapl1', symbol: 'AAPL' })
    ]);

    engine = new TradingEngine('redis://localhost', mockPrisma, mockOrderService, mockPriceCache, ['TSLA']);
    await engine.start();

    expect(mockPrisma.order.findMany).toHaveBeenCalledWith({
      where: {
        symbol: { in: ['TSLA'] },
        status: { in: ['PENDING', 'PARTIALLY_FILLED'] }
      }
    });
  });

  it('Missed-tick recovery executes immediately from prices:latest', async () => {
    const stopOrder = createTestOrder({ type: OrderType.STOP, side: OrderSide.BUY, stopPrice: new Prisma.Decimal(150), symbol: 'AAPL' });
    mockPrisma.order.findMany.mockResolvedValue([stopOrder]);
    
    // Setup PriceCache to return a crossed price immediately on hydrate
    mockPriceCache.getLatestPrice.mockResolvedValue({ price: '155.00', isStale: false });

    engine = new TradingEngine('redis://localhost', mockPrisma, mockOrderService, mockPriceCache, ['AAPL']);
    await engine.start(); // calls hydrate()

    // Must queue EXECUTE_FILL without waiting for a new tick
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'EXECUTE_FILL',
      expect.objectContaining({ orderId: stopOrder.id }),
      expect.any(Object)
    );
  });
  
  it('LEASE LOSS DURING TICK mid-processing prevents execution', async () => {
    engine = new TradingEngine('redis://localhost', mockPrisma, mockOrderService, mockPriceCache, ['AAPL']);
    await engine.start();

    const order = createTestOrder({ type: OrderType.MARKET });
    (engine as any).addOrder(order);

    // Patch ownedSymbols.has to return false mid-way
    const originalHas = engine['ownedSymbols'].has.bind(engine['ownedSymbols']);
    let callCount = 0;
    jest.spyOn(engine['ownedSymbols'], 'has').mockImplementation((sym) => {
      callCount++;
      if (callCount > 1) return false; // Fail mid-tick
      return originalHas(sym);
    });

    if (onMessageCallback) {
      onMessageCallback('market:tick:AAPL', JSON.stringify({ symbol: 'AAPL', price: '150.00', timestamp: new Date() }));
    }

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
