import { createEnvelope } from '../utils/envelope';
import { Prisma, PrismaClient, OrderSide, OrderType, OrderStatus, Order } from '@prisma/client';
import { LedgerService } from './ledger.service';
import { PositionService } from './position.service';

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

        if (dto.side === 'SELL') {
          await PositionService.checkPosition(tx, dto.portfolioId, dto.symbol, requestedQuantity);
        }

        if (dto.side === 'BUY') {
          const availableCash = new Prisma.Decimal(portfolio.totalCash).minus(portfolio.lockedCash);
          if (availableCash.lt(requiredCash)) throw new Error(`Insufficient funds: Required ${requiredCash.toString()}, Available ${availableCash.toString()}`);
          await tx.portfolio.update({
            where: { id: portfolio.id },
            data: { lockedCash: new Prisma.Decimal(portfolio.lockedCash).plus(requiredCash) }
          });
        } else if (dto.side === 'SELL') {
          await PositionService.lockPosition(tx, dto.portfolioId, dto.symbol, requestedQuantity);
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
            payload: createEnvelope('ORDER_ACCEPTED', { orderId: order.id, userId: order.userId, portfolioId: order.portfolioId }) 
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
          payload: createEnvelope('ORDER_PENDING', { orderId: updatedOrder.id, portfolioId: updatedOrder.portfolioId }) 
        }
      });

      return updatedOrder;
    });
  }

  public async activateStopLimit(orderId: string): Promise<Order> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM orders WHERE id = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      
      if (order.status !== OrderStatus.PENDING) {
        throw new Error(`Cannot activate STOP_LIMIT order ${orderId} in status ${order.status}`);
      }

      if (order.isActivated) {
        return order; // Already activated, idempotent
      }

      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data: { isActivated: true }
      });

      // Emit domain event for observability (optional but good practice)
      await tx.outboxEvent.create({
        data: { 
          type: 'ORDER_ACTIVATED', 
          aggregateType: 'Order',
          aggregateId: updatedOrder.id,
          payload: createEnvelope('ORDER_ACTIVATED', { orderId: updatedOrder.id, type: updatedOrder.type, portfolioId: updatedOrder.portfolioId }) 
        }
      });

      return updatedOrder;
    });
  }

  public async processFill(dto: FillOrderDto): Promise<Order> {
    const fillQty = new Prisma.Decimal(dto.quantity);
    const fillPrice = new Prisma.Decimal(dto.price);
    if (fillQty.lte(0)) throw new Error('Fill quantity must be greater than zero');

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM portfolios WHERE id = (SELECT portfolio_id FROM orders WHERE id = ${dto.orderId}) FOR UPDATE`;
        await tx.$executeRaw`SELECT 1 FROM positions WHERE portfolio_id = (SELECT portfolio_id FROM orders WHERE id = ${dto.orderId}) AND symbol = (SELECT symbol FROM orders WHERE id = ${dto.orderId}) FOR UPDATE`;
        await tx.$executeRaw`SELECT 1 FROM orders WHERE id = ${dto.orderId} FOR UPDATE`;

        const order = await tx.order.findUniqueOrThrow({ where: { id: dto.orderId } });
        
        if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.PARTIALLY_FILLED) {
          return order;
        }

        const requestedQty = new Prisma.Decimal(order.requestedQuantity);
        const currentFilledQty = new Prisma.Decimal(order.filledQuantity);
        const remainingQty = requestedQty.minus(currentFilledQty);

        if (remainingQty.lte(0)) {
          return order;
        }

        const newFilledQty = currentFilledQty.plus(fillQty);
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

        const updatedOrder = await tx.order.update({
          where: { id: order.id },
          data: {
            filledQuantity: newFilledQty,
            status: newState
          }
        });

        // Insert OrderFill (Enforcing Idempotency via schema constraint)
        const fill = await tx.orderFill.create({
          data: {
            orderId: order.id,
            price: fillPrice,
            quantity: fillQty,
            executionIdempotencyKey: dto.fillIdempotencyKey,
            realizedPnl: 0 // Will be updated for SELL later
          }
        });

        const portfolio = await tx.portfolio.findUniqueOrThrow({ where: { id: order.portfolioId } });
        const actualCost = fillQty.mul(fillPrice);
        let fillRealizedPnl = new Prisma.Decimal(0);

        if (order.side === 'BUY') {
          const reservationPrice = new Prisma.Decimal(order.reservationPrice || 0);
          const lockedReleased = fillQty.mul(reservationPrice);

          await tx.portfolio.update({
            where: { id: portfolio.id },
            data: {
              lockedCash: new Prisma.Decimal(portfolio.lockedCash).minus(lockedReleased),
              totalCash: new Prisma.Decimal(portfolio.totalCash).minus(actualCost)
            }
          });

          await PositionService.adjustOnBuy(tx, order.portfolioId, order.symbol, fillQty, fillPrice);

        } else {
          
          const { realizedPnl } = await PositionService.adjustOnSell(tx, order.portfolioId, order.symbol, fillQty, fillPrice);
          fillRealizedPnl = realizedPnl;

          await tx.orderFill.update({
            where: { id: fill.id },
            data: { realizedPnl: fillRealizedPnl }
          });

          await tx.portfolio.update({
            where: { id: portfolio.id },
            data: {
              totalCash: new Prisma.Decimal(portfolio.totalCash).plus(actualCost)
            }
          });
        }

        const fiatAccount = `user_cash_${order.userId}`;
        const secAccount = `user_sec_${order.userId}_${order.symbol}`;
        const platformFiatAccount = `platform_cash`;
        const platformSecAccount = `platform_sec_${order.symbol}`;

        const ledgerEntries = [];
        if (order.side === 'BUY') {
           ledgerEntries.push({ accountId: fiatAccount, assetType: 'FIAT', assetSymbol: 'USD', debit: actualCost, credit: 0 });
           ledgerEntries.push({ accountId: platformFiatAccount, assetType: 'FIAT', assetSymbol: 'USD', debit: 0, credit: actualCost });
           ledgerEntries.push({ accountId: platformSecAccount, assetType: 'SECURITY', assetSymbol: order.symbol, debit: fillQty, credit: 0 });
           ledgerEntries.push({ accountId: secAccount, assetType: 'SECURITY', assetSymbol: order.symbol, debit: 0, credit: fillQty });
        } else {
           ledgerEntries.push({ accountId: fiatAccount, assetType: 'FIAT', assetSymbol: 'USD', debit: 0, credit: actualCost });
           ledgerEntries.push({ accountId: platformFiatAccount, assetType: 'FIAT', assetSymbol: 'USD', debit: actualCost, credit: 0 });
           ledgerEntries.push({ accountId: platformSecAccount, assetType: 'SECURITY', assetSymbol: order.symbol, debit: 0, credit: fillQty });
           ledgerEntries.push({ accountId: secAccount, assetType: 'SECURITY', assetSymbol: order.symbol, debit: fillQty, credit: 0 });
        }

        await LedgerService.recordTransaction(tx, 'ORDER_FILL', fill.id, ledgerEntries);

        await tx.outboxEvent.create({
          data: { 
            type: 'ORDER_FILLED', 
            aggregateType: 'Order',
            aggregateId: order.id,
            payload: createEnvelope('ORDER_FILLED', { orderId: order.id, fillIdempotencyKey: dto.fillIdempotencyKey, portfolioId: order.portfolioId }) 
          }
        });

        return updatedOrder;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = error.meta?.target as any;
        const targetStr = Array.isArray(target) ? target.join(',') : String(target);
        if (targetStr.includes('execution_idempotency_key')) {
          return this.prisma.order.findUniqueOrThrow({ where: { id: dto.orderId } });
        }
      }
      throw error;
    }
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
          payload: createEnvelope('ORDER_CANCELLED', { orderId: order.id, portfolioId: order.portfolioId }) 
        }
      });

      return updatedOrder;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  public async expireOrder(orderId: string): Promise<Order> {
    console.log("@@@ EXPIRE ORDER CALLED: " + orderId, new Error().stack);
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
          payload: createEnvelope('ORDER_EXPIRED', { orderId: order.id, portfolioId: order.portfolioId }) 
        }
      });

      return updatedOrder;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
