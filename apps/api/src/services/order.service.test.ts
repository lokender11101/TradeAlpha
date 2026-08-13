import { PrismaClient, OrderSide, OrderType, OrderStatus } from '@prisma/client';
import { OrderService, PlaceOrderDto, FillOrderDto } from './order.service';

const prisma = new PrismaClient();
const orderService = new OrderService(prisma);

describe('OrderService - State Machine & Concurrency (Phase 2.3)', () => {
  let userId: string;
  let portfolioId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `test-fsm-${Date.now()}@example.com`,
        passwordHash: 'hash',
        portfolios: { create: { totalCash: 100000, lockedCash: 0 } }
      },
      include: { portfolios: true }
    });
    userId = user.id;
    portfolioId = user.portfolios[0].id;

    await prisma.position.create({
      data: { portfolioId, symbol: 'AAPL', quantity: 1000, lockedQuantity: 0, averageEntryPrice: 150 }
    });
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({});
    await prisma.orderFill.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.position.deleteMany({});
    await prisma.portfolio.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.$disconnect();
  });

  // State Transition Graph Tests
  describe('State Transition Graph Validation', () => {
    it('1. should allow every valid state transition', () => {
      const valid = [
        [OrderStatus.RECEIVED, OrderStatus.VALIDATED],
        [OrderStatus.RECEIVED, OrderStatus.REJECTED],
        [OrderStatus.VALIDATED, OrderStatus.ACCEPTED],
        [OrderStatus.VALIDATED, OrderStatus.REJECTED],
        [OrderStatus.ACCEPTED, OrderStatus.PENDING],
        [OrderStatus.ACCEPTED, OrderStatus.CANCELLED],
        [OrderStatus.ACCEPTED, OrderStatus.REJECTED],
        [OrderStatus.PENDING, OrderStatus.PARTIALLY_FILLED],
        [OrderStatus.PENDING, OrderStatus.FILLED],
        [OrderStatus.PENDING, OrderStatus.CANCELLED],
        [OrderStatus.PENDING, OrderStatus.EXPIRED],
        [OrderStatus.PARTIALLY_FILLED, OrderStatus.PARTIALLY_FILLED],
        [OrderStatus.PARTIALLY_FILLED, OrderStatus.FILLED],
        [OrderStatus.PARTIALLY_FILLED, OrderStatus.CANCELLED],
        [OrderStatus.PARTIALLY_FILLED, OrderStatus.EXPIRED]
      ];
      valid.forEach(([from, to]) => expect(OrderService.isValidTransition(from, to)).toBe(true));
    });

    it('2. should reject illegal state transitions', () => {
      const invalid = [
        [OrderStatus.FILLED, OrderStatus.CANCELLED],
        [OrderStatus.CANCELLED, OrderStatus.FILLED],
        [OrderStatus.REJECTED, OrderStatus.PENDING],
        [OrderStatus.EXPIRED, OrderStatus.FILLED],
        [OrderStatus.PARTIALLY_FILLED, OrderStatus.PENDING],
        [OrderStatus.RECEIVED, OrderStatus.FILLED]
      ];
      invalid.forEach(([from, to]) => expect(OrderService.isValidTransition(from, to)).toBe(false));
    });
  });

  describe('Order Execution Lifecycle', () => {
    it('should successfully place and transition an order from ACCEPTED to PENDING', async () => {
      const dto: PlaceOrderDto = {
        userId, portfolioId, symbol: 'AAPL', side: OrderSide.BUY, type: OrderType.LIMIT,
        requestedQuantity: 10, limitPrice: 150, currentMarketPrice: 150, idempotencyKey: `idemp-lifecycle-1-${Date.now()}`
      };
      let order = await orderService.placeOrder(dto);
      expect(order.status).toBe(OrderStatus.ACCEPTED);

      // ACCEPTED -> PENDING
      order = await orderService.markOrderPending(order.id);
      expect(order.status).toBe(OrderStatus.PENDING);
    });

    it('should process a partial fill (PENDING -> PARTIALLY_FILLED)', async () => {
      const dto: PlaceOrderDto = {
        userId, portfolioId, symbol: 'AAPL', side: OrderSide.BUY, type: OrderType.LIMIT,
        requestedQuantity: 10, limitPrice: 150, currentMarketPrice: 150, idempotencyKey: `idemp-lifecycle-2-${Date.now()}`
      };
      let order = await orderService.placeOrder(dto);
      order = await orderService.markOrderPending(order.id);

      const fillDto: FillOrderDto = { orderId: order.id, price: 150, quantity: 4, fillIdempotencyKey: `fill-1-${Date.now()}` };
      const filledOrder = await orderService.processFill(fillDto);
      expect(filledOrder.status).toBe(OrderStatus.PARTIALLY_FILLED);
      expect(filledOrder.filledQuantity.toNumber()).toBe(4);
    });

    it('should process full fill (PENDING -> FILLED)', async () => {
      const dto: PlaceOrderDto = {
        userId, portfolioId, symbol: 'AAPL', side: OrderSide.BUY, type: OrderType.LIMIT,
        requestedQuantity: 10, limitPrice: 150, currentMarketPrice: 150, idempotencyKey: `idemp-lifecycle-3-${Date.now()}`
      };
      let order = await orderService.placeOrder(dto);
      order = await orderService.markOrderPending(order.id);

      const fillDto: FillOrderDto = { orderId: order.id, price: 150, quantity: 10, fillIdempotencyKey: `fill-2-${Date.now()}` };
      const filledOrder = await orderService.processFill(fillDto);
      expect(filledOrder.status).toBe(OrderStatus.FILLED);
      expect(filledOrder.filledQuantity.toNumber()).toBe(10);
    });

    it('should allow partial fill followed by full fill (PARTIALLY_FILLED -> FILLED)', async () => {
      const dto: PlaceOrderDto = {
        userId, portfolioId, symbol: 'AAPL', side: OrderSide.BUY, type: OrderType.LIMIT,
        requestedQuantity: 10, limitPrice: 150, currentMarketPrice: 150, idempotencyKey: `idemp-lifecycle-4-${Date.now()}`
      };
      let order = await orderService.placeOrder(dto);
      order = await orderService.markOrderPending(order.id);

      await orderService.processFill({ orderId: order.id, price: 150, quantity: 4, fillIdempotencyKey: `fill-3-${Date.now()}` });
      const finalOrder = await orderService.processFill({ orderId: order.id, price: 150, quantity: 6, fillIdempotencyKey: `fill-4-${Date.now()}` });
      expect(finalOrder.status).toBe(OrderStatus.FILLED);
      expect(finalOrder.filledQuantity.toNumber()).toBe(10);
    });

    it('should throw if filledQuantity > requestedQuantity', async () => {
      const dto: PlaceOrderDto = {
        userId, portfolioId, symbol: 'AAPL', side: OrderSide.BUY, type: OrderType.LIMIT,
        requestedQuantity: 10, limitPrice: 150, currentMarketPrice: 150, idempotencyKey: `idemp-lifecycle-5-${Date.now()}`
      };
      let order = await orderService.placeOrder(dto);
      order = await orderService.markOrderPending(order.id);

      await expect(
        orderService.processFill({ orderId: order.id, price: 150, quantity: 11, fillIdempotencyKey: `fill-fail-1-${Date.now()}` })
      ).rejects.toThrow('filledQuantity cannot exceed requestedQuantity');
    });

    it('should safely process cancellation releasing unused reservations', async () => {
      const initialPortfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId }});
      
      const dto: PlaceOrderDto = {
        userId, portfolioId, symbol: 'AAPL', side: OrderSide.BUY, type: OrderType.LIMIT,
        requestedQuantity: 10, limitPrice: 150, currentMarketPrice: 150, idempotencyKey: `idemp-lifecycle-6-${Date.now()}`
      };
      let order = await orderService.placeOrder(dto); // locks 1500
      order = await orderService.markOrderPending(order.id);

      // Fill 4 (uses 600)
      await orderService.processFill({ orderId: order.id, price: 150, quantity: 4, fillIdempotencyKey: `fill-cancel-1-${Date.now()}` });

      // Cancel remaining 6 (releases 900)
      const cancelledOrder = await orderService.cancelOrder(order.id);
      expect(cancelledOrder.status).toBe(OrderStatus.CANCELLED);

      const finalPortfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId }});
      
      // Initial lockedCash should equal final lockedCash (it increased by 1500, decreased by 600 during fill, decreased by 900 during cancel)
      expect(finalPortfolio!.lockedCash.toNumber()).toBe(initialPortfolio!.lockedCash.toNumber());
    });

    it('should cleanly abort fills on CANCELLED, EXPIRED, or FILLED orders', async () => {
      const dto: PlaceOrderDto = {
        userId, portfolioId, symbol: 'AAPL', side: OrderSide.SELL, type: OrderType.MARKET,
        requestedQuantity: 10, currentMarketPrice: 150, idempotencyKey: `idemp-lifecycle-7-${Date.now()}`
      };
      let order = await orderService.placeOrder(dto);
      order = await orderService.markOrderPending(order.id);
      await orderService.expireOrder(order.id);

      const result = await orderService.processFill({ orderId: order.id, price: 150, quantity: 10, fillIdempotencyKey: `fill-fail-2-${Date.now()}` });
      expect(result.status).toBe(OrderStatus.EXPIRED);
      expect(result.filledQuantity.toNumber()).toBe(0);
    });

    it('should handle concurrent fills safely without overfilling', async () => {
      const dto: PlaceOrderDto = {
        userId, portfolioId, symbol: 'AAPL', side: OrderSide.BUY, type: OrderType.LIMIT,
        requestedQuantity: 100, limitPrice: 150, currentMarketPrice: 150, idempotencyKey: `idemp-conc-1-${Date.now()}`
      };
      let order = await orderService.placeOrder(dto);
      order = await orderService.markOrderPending(order.id);

      // Only 10 should actually mutate, the rest should safely abort idempotently.
      const fillRequests = Array.from({ length: 15 }).map((_, i) => 
        orderService.processFill({ orderId: order.id, price: 150, quantity: 10, fillIdempotencyKey: `fill-race-${i}-${Date.now()}` })
      );

      const results = await Promise.allSettled(fillRequests);
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      expect(fulfilled.length).toBe(15);
      expect(rejected.length).toBe(0);

      const finalOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(finalOrder!.status).toBe(OrderStatus.FILLED);
      expect(finalOrder!.filledQuantity.toNumber()).toBe(100);
    });

    it('should handle concurrent fill + cancel races without negative locks', async () => {
      const initialPortfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId }});
      
      const dto: PlaceOrderDto = {
        userId, portfolioId, symbol: 'AAPL', side: OrderSide.BUY, type: OrderType.LIMIT,
        requestedQuantity: 100, limitPrice: 150, currentMarketPrice: 150, idempotencyKey: `idemp-conc-2-${Date.now()}`
      };
      let order = await orderService.placeOrder(dto);
      order = await orderService.markOrderPending(order.id);

      // Race a 50 qty fill against a cancel.
      // Depending on lock acquisition order, either:
      // 1. Fill 50, then Cancel 50.
      // 2. Cancel 100, then Fill fails (Invalid transition).
      const [fillResult, cancelResult] = await Promise.allSettled([
        orderService.processFill({ orderId: order.id, price: 150, quantity: 50, fillIdempotencyKey: `fill-race-cancel-${Date.now()}` }),
        orderService.cancelOrder(order.id)
      ]);

      expect(cancelResult.status).toBe('fulfilled');
      expect(fillResult).toBeDefined();
      
      const finalPortfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId }});
      // The lockedCash should have fully returned to exactly what it was before the test.
      expect(finalPortfolio!.lockedCash.toNumber()).toBe(initialPortfolio!.lockedCash.toNumber());
    });
    it('should cleanly handle idempotent P2002 retries (Crash Scenario C)', async () => {
      const dto: PlaceOrderDto = {
        userId, portfolioId, symbol: 'AAPL', side: OrderSide.BUY, type: OrderType.LIMIT,
        requestedQuantity: 10, limitPrice: 150, currentMarketPrice: 150, idempotencyKey: `idemp-crash-c-${Date.now()}`
      };
      let order = await orderService.placeOrder(dto);
      order = await orderService.markOrderPending(order.id);

      const fillIdempotencyKey = `fill-crash-c-${Date.now()}`;
      
      const firstFill = await orderService.processFill({ orderId: order.id, price: 150, quantity: 10, fillIdempotencyKey });
      expect(firstFill.status).toBe(OrderStatus.FILLED);
      
      const secondFill = await orderService.processFill({ orderId: order.id, price: 150, quantity: 10, fillIdempotencyKey });
      expect(secondFill.status).toBe(OrderStatus.FILLED);
      expect(secondFill.filledQuantity.toNumber()).toBe(10);
    });

    it('should correctly balance the ledger per asset for fills', async () => {
      const dto: PlaceOrderDto = {
        userId, portfolioId, symbol: 'AAPL', side: OrderSide.BUY, type: OrderType.LIMIT,
        requestedQuantity: 10, limitPrice: 150, currentMarketPrice: 150, idempotencyKey: `idemp-ledger-${Date.now()}`
      };
      let order = await orderService.placeOrder(dto);
      order = await orderService.markOrderPending(order.id);

      const fillIdempotencyKey = `fill-ledger-${Date.now()}`;
      await orderService.processFill({ orderId: order.id, price: 150, quantity: 10, fillIdempotencyKey });

      const fills = await prisma.orderFill.findMany({ where: { orderId: order.id } });
      const fillId = fills[0].id;

      const entries = await prisma.ledgerEntry.findMany({
        where: { transaction: { referenceId: fillId, referenceType: 'ORDER_FILL' } }
      });
      
      const fiatEntries = entries.filter(e => e.assetType === 'FIAT');
      const secEntries = entries.filter(e => e.assetType === 'SECURITY');
      
      const fiatBalance = fiatEntries.reduce((acc, val) => acc + val.debit.toNumber() - val.credit.toNumber(), 0);
      const secBalance = secEntries.reduce((acc, val) => acc + val.debit.toNumber() - val.credit.toNumber(), 0);
      
      expect(fiatBalance).toBe(0);
      expect(secBalance).toBe(0);
    });
  });
});
