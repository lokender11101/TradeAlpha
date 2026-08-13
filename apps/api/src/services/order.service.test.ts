import { PrismaClient, OrderSide, OrderType } from '@prisma/client';
import { OrderService, PlaceOrderDto } from './order.service';

const prisma = new PrismaClient();
const orderService = new OrderService(prisma);

describe('OrderService - Place Order Integration', () => {
  let userId: string;
  let portfolioId: string;

  beforeAll(async () => {
    // Setup test user with 10,000 cash
    const user = await prisma.user.create({
      data: {
        email: `test-order-${Date.now()}@example.com`,
        passwordHash: 'hash',
        portfolios: {
          create: {
            totalCash: 10000,
            lockedCash: 0
          }
        }
      },
      include: { portfolios: true }
    });
    userId = user.id;
    portfolioId = user.portfolios[0].id;

    // Give user a position in AAPL
    await prisma.position.create({
      data: {
        portfolioId,
        symbol: 'AAPL',
        quantity: 50,
        lockedQuantity: 0,
        averageEntryPrice: 150
      }
    });
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.position.deleteMany({});
    await prisma.portfolio.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.$disconnect();
  });

  it('should throw if quantity is <= 0', async () => {
    const dto: PlaceOrderDto = {
      userId, portfolioId, symbol: 'AAPL', side: OrderSide.BUY, type: OrderType.MARKET,
      requestedQuantity: 0, currentMarketPrice: 150, idempotencyKey: `idemp-zero-${Date.now()}`
    };
    await expect(orderService.placeOrder(dto)).rejects.toThrow('Quantity must be greater than zero');
  });

  it('should successfully reserve funds for a MARKET BUY order (locks quantity * price * 1.05)', async () => {
    const dto: PlaceOrderDto = {
      userId, portfolioId, symbol: 'AAPL', side: OrderSide.BUY, type: OrderType.MARKET,
      requestedQuantity: 10, currentMarketPrice: 150, idempotencyKey: `idemp-1-${Date.now()}`
    };
    
    // 10 * (150 * 1.05) = 1575 required cash
    const order = await orderService.placeOrder(dto);
    expect(order).toBeDefined();
    expect(order.status).toBe('ACCEPTED');

    const portfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId } });
    expect(portfolio?.lockedCash.toNumber()).toBe(1575);
    
    const outbox = await prisma.outboxEvent.findFirst({ where: { type: 'ORDER_ACCEPTED' } });
    expect(outbox).toBeDefined();
  });

  it('should successfully reserve shares for a LIMIT SELL order', async () => {
    const dto: PlaceOrderDto = {
      userId, portfolioId, symbol: 'AAPL', side: OrderSide.SELL, type: OrderType.LIMIT,
      requestedQuantity: 20, limitPrice: 160, currentMarketPrice: 150, idempotencyKey: `idemp-2-${Date.now()}`
    };
    
    const order = await orderService.placeOrder(dto);
    expect(order).toBeDefined();
    
    const position = await prisma.position.findUnique({ where: { portfolioId_symbol: { portfolioId, symbol: 'AAPL' } } });
    expect(position?.lockedQuantity.toNumber()).toBe(20);
  });

  it('should fail if insufficient funds', async () => {
    const dto: PlaceOrderDto = {
      userId, portfolioId, symbol: 'MSFT', side: OrderSide.BUY, type: OrderType.LIMIT,
      requestedQuantity: 100, limitPrice: 200, currentMarketPrice: 200, idempotencyKey: `idemp-3-${Date.now()}`
    };
    // Requires 20,000 cash, user only has 10,000 (with 1,575 already locked)
    await expect(orderService.placeOrder(dto)).rejects.toThrow(/Insufficient funds/);
  });

  it('should fail if insufficient shares', async () => {
    const dto: PlaceOrderDto = {
      userId, portfolioId, symbol: 'AAPL', side: OrderSide.SELL, type: OrderType.MARKET,
      requestedQuantity: 40, currentMarketPrice: 150, idempotencyKey: `idemp-4-${Date.now()}`
    };
    // User has 50 shares, but 20 are already locked. Available = 30. Requested = 40.
    await expect(orderService.placeOrder(dto)).rejects.toThrow(/Insufficient quantity/);
  });

  it('should return existing order on duplicate idempotency key', async () => {
    const idempotencyKey = `idemp-dup-${Date.now()}`;
    const dto: PlaceOrderDto = {
      userId, portfolioId, symbol: 'TSLA', side: OrderSide.BUY, type: OrderType.LIMIT,
      requestedQuantity: 5, limitPrice: 100, currentMarketPrice: 100, idempotencyKey
    };
    
    const firstOrder = await orderService.placeOrder(dto);
    expect(firstOrder).toBeDefined();
    
    const secondOrder = await orderService.placeOrder(dto);
    expect(secondOrder.id).toBe(firstOrder.id);
  });

  it('should handle 5 concurrent BUY requests safely', async () => {
    // Assuming each requires 100 cash. 5 * 100 = 500. We have plenty left.
    const dtos = Array.from({ length: 5 }).map((_, i) => ({
      userId, portfolioId, symbol: 'TSLA', side: OrderSide.BUY as OrderSide, type: OrderType.LIMIT as OrderType,
      requestedQuantity: 1, limitPrice: 100, currentMarketPrice: 100, idempotencyKey: `idemp-conc-${i}-${Date.now()}`
    }));

    const results = await Promise.all(dtos.map(dto => orderService.placeOrder(dto)));
    expect(results).toHaveLength(5);
    results.forEach(order => expect(order.status).toBe('ACCEPTED'));
  });

  it('should handle concurrency safely when racing for insufficient funds', async () => {
    // User has around 7925 cash left. Let's try 10 concurrent requests of 1000 cash.
    // Only 7 should succeed. The rest should fail with Insufficient funds.
    const dtos = Array.from({ length: 10 }).map((_, i) => ({
      userId, portfolioId, symbol: 'AMZN', side: OrderSide.BUY as OrderSide, type: OrderType.LIMIT as OrderType,
      requestedQuantity: 10, limitPrice: 100, currentMarketPrice: 100, idempotencyKey: `idemp-race-${i}-${Date.now()}`
    }));

    const results = await Promise.allSettled(dtos.map(dto => orderService.placeOrder(dto)));
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    expect(fulfilled.length).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0);
    expect(fulfilled.length + rejected.length).toBe(10);
    
    // Verify cash is never negative
    const portfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId } });
    const availableCash = portfolio!.totalCash.toNumber() - portfolio!.lockedCash.toNumber();
    expect(availableCash).toBeGreaterThanOrEqual(0);
  });
});
