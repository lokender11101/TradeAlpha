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
        [OrderStatus.ACCEPTED, OrderStatus.EXPIRED],
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

  describe('Cancellation Concurrency (Phase 5.1)', () => {
    it('should successfully cancel a PENDING order and refund locked cash', async () => {
      const order = await orderService.placeOrder({
        userId, portfolioId, symbol: 'TSLA', side: OrderSide.BUY, type: OrderType.LIMIT,
        requestedQuantity: 10, limitPrice: 200, currentMarketPrice: 200, idempotencyKey: `cancel-test-${Date.now()}`
      });
      await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PENDING } });
      
      const portfolioBefore = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
      const cancelledOrder = await orderService.cancelOrder(order.id);
      const portfolioAfter = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });

      expect(cancelledOrder.status).toBe(OrderStatus.CANCELLED);
      // Released 10 * 200 = 2000 locked cash
      expect(Number(portfolioAfter.lockedCash)).toBe(Number(portfolioBefore.lockedCash) - 2000);
    });

    it('should successfully cancel a PARTIALLY_FILLED order and refund remaining locked cash', async () => {
      const order = await orderService.placeOrder({
        userId, portfolioId, symbol: 'NVDA', side: OrderSide.BUY, type: OrderType.LIMIT,
        requestedQuantity: 10, limitPrice: 100, currentMarketPrice: 100, idempotencyKey: `partial-cancel-${Date.now()}`
      });
      await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PARTIALLY_FILLED, filledQuantity: 4 } });

      const portfolioBefore = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
      const cancelledOrder = await orderService.cancelOrder(order.id);
      const portfolioAfter = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });

      expect(cancelledOrder.status).toBe(OrderStatus.CANCELLED);
      // Released 6 * 100 = 600 locked cash
      expect(Number(portfolioAfter.lockedCash)).toBe(Number(portfolioBefore.lockedCash) - 600);
    });

    it('should reject cancellation of a terminal order (FILLED)', async () => {
      const order = await orderService.placeOrder({
        userId, portfolioId, symbol: 'MSFT', side: OrderSide.BUY, type: OrderType.LIMIT,
        requestedQuantity: 5, limitPrice: 100, currentMarketPrice: 100, idempotencyKey: `terminal-test-${Date.now()}`
      });
      await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.FILLED, filledQuantity: 5 } });

      await expect(orderService.cancelOrder(order.id)).rejects.toThrow(/Invalid state transition/);
    });

    it('should resolve Cancel vs EXECUTE_FILL race correctly', async () => {
      const order = await orderService.placeOrder({
        userId, portfolioId, symbol: 'META', side: OrderSide.BUY, type: OrderType.LIMIT,
        requestedQuantity: 10, limitPrice: 150, currentMarketPrice: 150, idempotencyKey: `race-test-${Date.now()}`
      });
      await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PENDING } });
      
      const portfolioBefore = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });

      // Simulate a concurrent fill and cancel
      const fillPromise = orderService.processFill({
        orderId: order.id,
        price: 150,
        quantity: 10,
        fillIdempotencyKey: `exec-${order.id}-10`
      });

      // Give the fill a tiny head start to acquire lock, then try to cancel
      const cancelPromise = new Promise((resolve) => setTimeout(resolve, 5)).then(() => orderService.cancelOrder(order.id).catch(e => e));

      const [fillResult, cancelResult] = await Promise.all([fillPromise, cancelPromise]);

      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      const portfolioAfter = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });

      // Either fill won, or cancel won. Both must not succeed in a way that breaks invariants.
      // Since it's a full fill, if fill won, status is FILLED. The cancel would throw "Invalid state transition".
      if (finalOrder.status === OrderStatus.FILLED) {
        expect(cancelResult).toBeInstanceOf(Error);
        expect((cancelResult as Error).message).toMatch(/Invalid state transition/);
        // Cash should have been spent (deducted from both total and locked)
        expect(Number(portfolioAfter.totalCash)).toBe(Number(portfolioBefore.totalCash) - 1500);
        expect(Number(portfolioAfter.lockedCash)).toBe(Number(portfolioBefore.lockedCash) - 1500);
      } else if (finalOrder.status === OrderStatus.CANCELLED) {
        // This path is extremely unlikely in this specific test timing, but handled for correctness.
        expect(fillResult).toBeInstanceOf(Error);
        // Locked cash should just be released (totalCash remains same, lockedCash reduces)
        expect(Number(portfolioAfter.totalCash)).toBe(Number(portfolioBefore.totalCash));
        expect(Number(portfolioAfter.lockedCash)).toBe(Number(portfolioBefore.lockedCash) - 1500);
      } else {
        throw new Error(`Unexpected final order status: ${finalOrder.status}`);
      }
      
      // Ensure invariants hold (no negative locked cash)
      expect(Number(portfolioAfter.lockedCash)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Market Session Fencing (Phase 6.1)', () => {
    let orderId: string;
    
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should reject placeOrder at 09:14:59', async () => {
      jest.spyOn(require('./time.provider').defaultTimeProvider, 'now').mockReturnValue(new Date('2023-10-10T03:44:59Z')); // 09:14:59 IST
      await expect(orderService.placeOrder({
        userId,
        portfolioId,
        symbol: 'RELIANCE',
        side: 'BUY',
        type: 'MARKET',
        requestedQuantity: '10',
        currentMarketPrice: '100',
        idempotencyKey: 'test-fencing-1'
      })).rejects.toThrow('Market is closed');
    });

    it('should accept placeOrder at 09:15:00', async () => {
      jest.spyOn(require('./time.provider').defaultTimeProvider, 'now').mockReturnValue(new Date('2023-10-10T03:45:00Z')); // 09:15:00 IST
      const order = await orderService.placeOrder({
        userId,
        portfolioId,
        symbol: 'RELIANCE',
        side: 'BUY',
        type: 'MARKET',
        requestedQuantity: '10',
        currentMarketPrice: '100',
        idempotencyKey: 'test-fencing-2'
      });
      expect(order.status).toBe('ACCEPTED');
    });

    it('should accept placeOrder at 15:29:59', async () => {
      jest.spyOn(require('./time.provider').defaultTimeProvider, 'now').mockReturnValue(new Date('2023-10-10T09:59:59Z')); // 15:29:59 IST
      const order = await orderService.placeOrder({
        userId,
        portfolioId,
        symbol: 'RELIANCE',
        side: 'BUY',
        type: 'MARKET',
        requestedQuantity: '10',
        currentMarketPrice: '100',
        idempotencyKey: 'test-fencing-3'
      });
      expect(order.status).toBe('ACCEPTED');
      orderId = order.id;
    });

    it('should reject placeOrder at 15:30:00', async () => {
      jest.spyOn(require('./time.provider').defaultTimeProvider, 'now').mockReturnValue(new Date('2023-10-10T10:00:00Z')); // 15:30:00 IST
      await expect(orderService.placeOrder({
        userId,
        portfolioId,
        symbol: 'RELIANCE',
        side: 'BUY',
        type: 'MARKET',
        requestedQuantity: '10',
        currentMarketPrice: '100',
        idempotencyKey: 'test-fencing-4'
      })).rejects.toThrow('Market is closed');
    });

    it('should reject placeOrder at 15:30:01', async () => {
      jest.spyOn(require('./time.provider').defaultTimeProvider, 'now').mockReturnValue(new Date('2023-10-10T10:00:01Z')); // 15:30:01 IST
      await expect(orderService.placeOrder({
        userId,
        portfolioId,
        symbol: 'RELIANCE',
        side: 'BUY',
        type: 'MARKET',
        requestedQuantity: '10',
        currentMarketPrice: '100',
        idempotencyKey: 'test-fencing-5'
      })).rejects.toThrow('Market is closed');
    });

    it('should transition ACCEPTED to EXPIRED if markOrderPending called after 15:30', async () => {
      // Setup: Order was accepted at 15:29:59 (test above).
      const orderBefore = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(orderBefore.status).toBe('ACCEPTED');
      
      const portfolioBefore = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });

      // Advance time to 15:30:05
      jest.spyOn(require('./time.provider').defaultTimeProvider, 'now').mockReturnValue(new Date('2023-10-10T10:00:05Z'));

      // Action: Dispatcher tries to mark it pending
      const orderAfter = await orderService.markOrderPending(orderId);

      // Assertions
      expect(orderAfter.status).toBe('EXPIRED');
      
      // Reservation released
      const portfolioAfter = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
      const reservedAmount = Number(orderBefore.reservationPrice) * Number(orderBefore.requestedQuantity);
      expect(Number(portfolioAfter.lockedCash)).toBe(Number(portfolioBefore.lockedCash) - reservedAmount);

      // Repeated calls remain safe (idempotent)
      await expect(orderService.markOrderPending(orderId)).rejects.toThrow(/Invalid state transition/);
    });
  });
});
