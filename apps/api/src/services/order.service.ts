import { Prisma, PrismaClient, OrderSide, OrderType, OrderStatus, Order } from '@prisma/client';

export type PlaceOrderDto = {
  userId: string;
  portfolioId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  requestedQuantity: Prisma.Decimal | number | string;
  limitPrice?: Prisma.Decimal | number | string | null;
  stopPrice?: Prisma.Decimal | number | string | null;
  currentMarketPrice: Prisma.Decimal | number | string;
  idempotencyKey: string;
};

export type FillOrderDto = {
  orderId: string;
  price: Prisma.Decimal | number | string;
  quantity: Prisma.Decimal | number | string;
  fillIdempotencyKey: string;
};

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  RECEIVED: ['VALIDATED', 'REJECTED'],
  VALIDATED: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: ['PENDING', 'CANCELLED', 'REJECTED'],
  PENDING: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED'],
  FILLED: [],
  CANCELLED: [],
  REJECTED: [],
  EXPIRED: []
};

export class OrderService {
  constructor(private readonly prisma: PrismaClient) {}

  public static isValidTransition(from: OrderStatus, to: OrderStatus): boolean {
    return VALID_TRANSITIONS[from].includes(to);
  }

  public async placeOrder(dto: PlaceOrderDto) {
    const requestedQuantity = new Prisma.Decimal(dto.requestedQuantity);
    if (requestedQuantity.lte(0)) {
      throw new Error('Quantity must be greater than zero');
    }
    if (dto.type === 'LIMIT' && !dto.limitPrice) throw new Error('LIMIT orders require a limitPrice');
    if (dto.type === 'STOP' && !dto.stopPrice) throw new Error('STOP orders require a stopPrice');
    if (dto.type === 'STOP_LIMIT' && (!dto.stopPrice || !dto.limitPrice)) throw new Error('STOP_LIMIT orders require both stopPrice and limitPrice');

    const existing = await this.prisma.order.findUnique({
      where: { idx_orders_user_idempotency: { userId: dto.userId, idempotencyKey: dto.idempotencyKey } }
    });
    if (existing) return existing;

    const currentMarketPrice = new Prisma.Decimal(dto.currentMarketPrice);
    let reservationPrice = new Prisma.Decimal(0);
    
    if (dto.side === 'BUY') {
      if (dto.type === 'LIMIT' || dto.type === 'STOP_LIMIT') {
        reservationPrice = new Prisma.Decimal(dto.limitPrice!);
      } else {
        reservationPrice = currentMarketPrice.mul(1.05);
      }
    }

    const requiredCash = dto.side === 'BUY' ? requestedQuantity.mul(reservationPrice) : new Prisma.Decimal(0);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM portfolios WHERE id = ${dto.portfolioId} FOR UPDATE`;
        const portfolio = await tx.portfolio.findUniqueOrThrow({ where: { id: dto.portfolioId } });
        
        if (portfolio.userId !== dto.userId) throw new Error('Unauthorized: Portfolio does not belong to user');

        let position = null;
        if (dto.side === 'SELL') {
          const positions = await tx.$queryRaw<{id: string}[]>`
            SELECT id FROM positions 
            WHERE portfolio_id = ${dto.portfolioId} AND symbol = ${dto.symbol} 
            FOR UPDATE
          `;
          if (!positions || positions.length === 0) throw new Error(`Insufficient quantity: No position found for ${dto.symbol}`);
          position = await tx.position.findUniqueOrThrow({ where: { id: positions[0].id } });
        }

        if (dto.side === 'BUY') {
          const availableCash = new Prisma.Decimal(portfolio.totalCash).minus(portfolio.lockedCash);
          if (availableCash.lt(requiredCash)) throw new Error(`Insufficient funds: Required ${requiredCash.toString()}, Available ${availableCash.toString()}`);
          await tx.portfolio.update({
            where: { id: portfolio.id },
            data: { lockedCash: new Prisma.Decimal(portfolio.lockedCash).plus(requiredCash) }
          });
        } else if (dto.side === 'SELL' && position) {
          const availableQty = new Prisma.Decimal(position.quantity).minus(position.lockedQuantity);
          if (availableQty.lt(requestedQuantity)) throw new Error(`Insufficient quantity: Required ${requestedQuantity.toString()}, Available ${availableQty.toString()}`);
          await tx.position.update({
            where: { id: position.id },
            data: { lockedQuantity: new Prisma.Decimal(position.lockedQuantity).plus(requestedQuantity) }
          });
        }

        const order = await tx.order.create({
          data: {
            userId: dto.userId,
            portfolioId: dto.portfolioId,
            symbol: dto.symbol,
            side: dto.side,
            type: dto.type,
            requestedQuantity: requestedQuantity,
            limitPrice: dto.limitPrice ? new Prisma.Decimal(dto.limitPrice) : null,
            stopPrice: dto.stopPrice ? new Prisma.Decimal(dto.stopPrice) : null,
            reservationPrice: dto.side === 'BUY' ? reservationPrice : null,
            status: OrderStatus.ACCEPTED,
            idempotencyKey: dto.idempotencyKey
          }
        });

        await tx.outboxEvent.create({
          data: { 
            type: 'ORDER_ACCEPTED', 
            aggregateType: 'Order', 
            aggregateId: order.id, 
            payload: { orderId: order.id, userId: order.userId } 
          }
        });

        return order;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existingOrder = await this.prisma.order.findUnique({
          where: { idx_orders_user_idempotency: { userId: dto.userId, idempotencyKey: dto.idempotencyKey } }
        });
        if (existingOrder) return existingOrder;
      }
      throw error;
    }
  }

  public async markOrderPending(orderId: string): Promise<Order> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM orders WHERE id = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      
      if (!OrderService.isValidTransition(order.status, OrderStatus.PENDING)) {
        throw new Error(`Invalid state transition from ${order.status} to PENDING`);
      }
      
      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.PENDING }
      });

      await tx.outboxEvent.create({
        data: { 
          type: 'ORDER_PENDING', 
          aggregateType: 'Order',
          aggregateId: updatedOrder.id,
          payload: { orderId: updatedOrder.id } 
        }
      });

      return updatedOrder;
    });
  }

  public async processFill(dto: FillOrderDto): Promise<Order> {
    const fillQty = new Prisma.Decimal(dto.quantity);
    if (fillQty.lte(0)) throw new Error('Fill quantity must be greater than zero');

    return this.prisma.$transaction(async (tx) => {
      // Deduplicate fill by idempotencyKey to prevent duplicate processing
      const existingOutbox = await tx.$queryRaw<{id: string}[]>`
        SELECT id FROM outbox_events WHERE type = 'ORDER_FILLED' AND payload->>'fillIdempotencyKey' = ${dto.fillIdempotencyKey} FOR UPDATE
      `;
      if (existingOutbox && existingOutbox.length > 0) {
        return tx.order.findUniqueOrThrow({ where: { id: dto.orderId } });
      }

      await tx.$executeRaw`SELECT 1 FROM portfolios WHERE id = (SELECT portfolio_id FROM orders WHERE id = ${dto.orderId}) FOR UPDATE`;
      await tx.$executeRaw`SELECT 1 FROM positions WHERE portfolio_id = (SELECT portfolio_id FROM orders WHERE id = ${dto.orderId}) AND symbol = (SELECT symbol FROM orders WHERE id = ${dto.orderId}) FOR UPDATE`;
      await tx.$executeRaw`SELECT 1 FROM orders WHERE id = ${dto.orderId} FOR UPDATE`;

      const order = await tx.order.findUniqueOrThrow({ where: { id: dto.orderId } });
      
      const newFilledQty = new Prisma.Decimal(order.filledQuantity).plus(fillQty);
      const requestedQty = new Prisma.Decimal(order.requestedQuantity);
      
      if (newFilledQty.gt(requestedQty)) {
        throw new Error('filledQuantity cannot exceed requestedQuantity');
      }

      let newState: OrderStatus = OrderStatus.PARTIALLY_FILLED;
      if (newFilledQty.equals(requestedQty)) {
        newState = OrderStatus.FILLED;
      }

      if (!OrderService.isValidTransition(order.status, newState)) {
        throw new Error(`Invalid state transition from ${order.status} to ${newState}`);
      }

      // Update Order
      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: {
          filledQuantity: newFilledQty,
          status: newState
        }
      });

      // Update OrderFill
      const fill = await tx.orderFill.create({
        data: {
          orderId: order.id,
          price: new Prisma.Decimal(dto.price),
          quantity: fillQty
        }
      });

      const portfolio = await tx.portfolio.findUniqueOrThrow({ where: { id: order.portfolioId } });

      if (order.side === 'BUY') {
        // Decrease locked cash by (fillQty * reservationPrice)
        // Deduct actual cost from totalCash.
        const reservationPrice = new Prisma.Decimal(order.reservationPrice || 0);
        const lockedReleased = fillQty.mul(reservationPrice);
        const actualCost = fillQty.mul(fill.price);

        await tx.portfolio.update({
          where: { id: portfolio.id },
          data: {
            lockedCash: new Prisma.Decimal(portfolio.lockedCash).minus(lockedReleased),
            totalCash: new Prisma.Decimal(portfolio.totalCash).minus(actualCost)
          }
        });

        // Add to Position
        const position = await tx.position.findUnique({
          where: { portfolioId_symbol: { portfolioId: order.portfolioId, symbol: order.symbol } }
        });

        if (position) {
          const totalCost = new Prisma.Decimal(position.quantity).mul(position.averageEntryPrice).plus(actualCost);
          const newQty = new Prisma.Decimal(position.quantity).plus(fillQty);
          const newAvgPrice = totalCost.div(newQty);
          
          await tx.position.update({
            where: { id: position.id },
            data: {
              quantity: newQty,
              averageEntryPrice: newAvgPrice
            }
          });
        } else {
          await tx.position.create({
            data: {
              portfolioId: order.portfolioId,
              symbol: order.symbol,
              quantity: fillQty,
              averageEntryPrice: fill.price
            }
          });
        }
      } else {
        // SELL
        // Decrease lockedQuantity and total quantity.
        // Increase totalCash by actual proceeds.
        const position = await tx.position.findUniqueOrThrow({
          where: { portfolioId_symbol: { portfolioId: order.portfolioId, symbol: order.symbol } }
        });

        const actualProceeds = fillQty.mul(fill.price);

        await tx.position.update({
          where: { id: position.id },
          data: {
            lockedQuantity: new Prisma.Decimal(position.lockedQuantity).minus(fillQty),
            quantity: new Prisma.Decimal(position.quantity).minus(fillQty)
          }
        });

        await tx.portfolio.update({
          where: { id: portfolio.id },
          data: {
            totalCash: new Prisma.Decimal(portfolio.totalCash).plus(actualProceeds)
          }
        });
      }

      await tx.outboxEvent.create({
        data: { 
          type: 'ORDER_FILLED', 
          aggregateType: 'Order',
          aggregateId: order.id,
          payload: { orderId: order.id, fillIdempotencyKey: dto.fillIdempotencyKey } 
        }
      });

      return updatedOrder;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  public async cancelOrder(orderId: string): Promise<Order> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM portfolios WHERE id = (SELECT portfolio_id FROM orders WHERE id = ${orderId}) FOR UPDATE`;
      await tx.$executeRaw`SELECT 1 FROM positions WHERE portfolio_id = (SELECT portfolio_id FROM orders WHERE id = ${orderId}) AND symbol = (SELECT symbol FROM orders WHERE id = ${orderId}) FOR UPDATE`;
      await tx.$executeRaw`SELECT 1 FROM orders WHERE id = ${orderId} FOR UPDATE`;

      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });

      if (!OrderService.isValidTransition(order.status, OrderStatus.CANCELLED)) {
        throw new Error(`Invalid state transition from ${order.status} to CANCELLED`);
      }

      const remainingQty = new Prisma.Decimal(order.requestedQuantity).minus(order.filledQuantity);

      if (remainingQty.gt(0)) {
        if (order.side === 'BUY') {
          const reservationPrice = new Prisma.Decimal(order.reservationPrice || 0);
          const lockedReleased = remainingQty.mul(reservationPrice);
          const portfolio = await tx.portfolio.findUniqueOrThrow({ where: { id: order.portfolioId } });
          
          await tx.portfolio.update({
            where: { id: portfolio.id },
            data: { lockedCash: new Prisma.Decimal(portfolio.lockedCash).minus(lockedReleased) }
          });
        } else {
          const position = await tx.position.findUniqueOrThrow({
            where: { portfolioId_symbol: { portfolioId: order.portfolioId, symbol: order.symbol } }
          });
          
          await tx.position.update({
            where: { id: position.id },
            data: { lockedQuantity: new Prisma.Decimal(position.lockedQuantity).minus(remainingQty) }
          });
        }
      }

      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CANCELLED }
      });

      await tx.outboxEvent.create({
        data: { 
          type: 'ORDER_CANCELLED', 
          aggregateType: 'Order',
          aggregateId: order.id,
          payload: { orderId: order.id } 
        }
      });

      return updatedOrder;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  public async expireOrder(orderId: string): Promise<Order> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM portfolios WHERE id = (SELECT portfolio_id FROM orders WHERE id = ${orderId}) FOR UPDATE`;
      await tx.$executeRaw`SELECT 1 FROM positions WHERE portfolio_id = (SELECT portfolio_id FROM orders WHERE id = ${orderId}) AND symbol = (SELECT symbol FROM orders WHERE id = ${orderId}) FOR UPDATE`;
      await tx.$executeRaw`SELECT 1 FROM orders WHERE id = ${orderId} FOR UPDATE`;

      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });

      if (!OrderService.isValidTransition(order.status, OrderStatus.EXPIRED)) {
        throw new Error(`Invalid state transition from ${order.status} to EXPIRED`);
      }

      const remainingQty = new Prisma.Decimal(order.requestedQuantity).minus(order.filledQuantity);

      if (remainingQty.gt(0)) {
        if (order.side === 'BUY') {
          const reservationPrice = new Prisma.Decimal(order.reservationPrice || 0);
          const lockedReleased = remainingQty.mul(reservationPrice);
          const portfolio = await tx.portfolio.findUniqueOrThrow({ where: { id: order.portfolioId } });
          
          await tx.portfolio.update({
            where: { id: portfolio.id },
            data: { lockedCash: new Prisma.Decimal(portfolio.lockedCash).minus(lockedReleased) }
          });
        } else {
          const position = await tx.position.findUniqueOrThrow({
            where: { portfolioId_symbol: { portfolioId: order.portfolioId, symbol: order.symbol } }
          });
          
          await tx.position.update({
            where: { id: position.id },
            data: { lockedQuantity: new Prisma.Decimal(position.lockedQuantity).minus(remainingQty) }
          });
        }
      }

      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.EXPIRED }
      });

      await tx.outboxEvent.create({
        data: { 
          type: 'ORDER_EXPIRED', 
          aggregateType: 'Order',
          aggregateId: order.id,
          payload: { orderId: order.id } 
        }
      });

      return updatedOrder;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
