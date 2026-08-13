import { Prisma, PrismaClient, OrderSide, OrderType, OrderStatus } from '@prisma/client';

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

export class OrderService {
  constructor(private readonly prisma: PrismaClient) {}

  public async placeOrder(dto: PlaceOrderDto) {
    // 1. Input Validation
    const requestedQuantity = new Prisma.Decimal(dto.requestedQuantity);
    if (requestedQuantity.lte(0)) {
      throw new Error('Quantity must be greater than zero');
    }
    
    if (dto.type === 'LIMIT' && !dto.limitPrice) {
      throw new Error('LIMIT orders require a limitPrice');
    }
    
    if (dto.type === 'STOP' && !dto.stopPrice) {
      throw new Error('STOP orders require a stopPrice');
    }
    
    if (dto.type === 'STOP_LIMIT' && (!dto.stopPrice || !dto.limitPrice)) {
      throw new Error('STOP_LIMIT orders require both stopPrice and limitPrice');
    }

    // Check Idempotency without transaction first to return early if possible
    const existing = await this.prisma.order.findUnique({
      where: {
        idx_orders_user_idempotency: {
          userId: dto.userId,
          idempotencyKey: dto.idempotencyKey
        }
      }
    });

    if (existing) {
      return existing;
    }

    // Calculate required lock amounts
    const currentMarketPrice = new Prisma.Decimal(dto.currentMarketPrice);
    let reservationPrice = new Prisma.Decimal(0);
    
    if (dto.side === 'BUY') {
      if (dto.type === 'LIMIT' || dto.type === 'STOP_LIMIT') {
        reservationPrice = new Prisma.Decimal(dto.limitPrice!);
      } else {
        // MARKET or STOP order: use current market price + 5% buffer
        reservationPrice = currentMarketPrice.mul(1.05);
      }
    }

    const requiredCash = dto.side === 'BUY' ? requestedQuantity.mul(reservationPrice) : new Prisma.Decimal(0);

    // 2. Execute Transaction
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Lock Portfolio First
        await tx.$executeRaw`SELECT 1 FROM portfolios WHERE id = ${dto.portfolioId} FOR UPDATE`;
        const portfolio = await tx.portfolio.findUniqueOrThrow({ where: { id: dto.portfolioId } });
        
        if (portfolio.userId !== dto.userId) {
          throw new Error('Unauthorized: Portfolio does not belong to user');
        }

        // Lock Position if SELL
        let position = null;
        if (dto.side === 'SELL') {
          const positions = await tx.$queryRaw<{id: string}[]>`
            SELECT id FROM positions 
            WHERE portfolio_id = ${dto.portfolioId} AND symbol = ${dto.symbol} 
            FOR UPDATE
          `;
          if (!positions || positions.length === 0) {
            throw new Error(`Insufficient quantity: No position found for ${dto.symbol}`);
          }
          position = await tx.position.findUniqueOrThrow({ where: { id: positions[0].id } });
        }

        // Verify & Reserve Funds/Shares
        if (dto.side === 'BUY') {
          const availableCash = new Prisma.Decimal(portfolio.totalCash).minus(portfolio.lockedCash);
          if (availableCash.lt(requiredCash)) {
            throw new Error(`Insufficient funds: Required ${requiredCash.toString()}, Available ${availableCash.toString()}`);
          }
          await tx.portfolio.update({
            where: { id: portfolio.id },
            data: { lockedCash: new Prisma.Decimal(portfolio.lockedCash).plus(requiredCash) }
          });
        } else if (dto.side === 'SELL' && position) {
          const availableQty = new Prisma.Decimal(position.quantity).minus(position.lockedQuantity);
          if (availableQty.lt(requestedQuantity)) {
            throw new Error(`Insufficient quantity: Required ${requestedQuantity.toString()}, Available ${availableQty.toString()}`);
          }
          await tx.position.update({
            where: { id: position.id },
            data: { lockedQuantity: new Prisma.Decimal(position.lockedQuantity).plus(requestedQuantity) }
          });
        }

        // Create Order
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
            status: OrderStatus.ACCEPTED,
            idempotencyKey: dto.idempotencyKey
          }
        });

        // Create Outbox Event
        await tx.outboxEvent.create({
          data: {
            type: 'ORDER_ACCEPTED',
            payload: { orderId: order.id, userId: order.userId, idempotencyKey: order.idempotencyKey }
          }
        });

        return order;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existingOrder = await this.prisma.order.findUnique({
          where: {
            idx_orders_user_idempotency: {
              userId: dto.userId,
              idempotencyKey: dto.idempotencyKey
            }
          }
        });
        if (existingOrder) return existingOrder;
      }
      throw error;
    }
  }
}
