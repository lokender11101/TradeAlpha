import { createEnvelope } from '../utils/envelope';
import { Prisma, Position, PositionStatus } from '@prisma/client';

export class PositionService {
  static async checkPosition(tx: Prisma.TransactionClient, portfolioId: string, symbol: string, requiredQuantity: Prisma.Decimal): Promise<Position | null> {
    const portfolio = await tx.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    
    const positions = await tx.$queryRaw<{id: string}[]>`
      SELECT id FROM positions 
      WHERE portfolio_id = ${portfolioId} AND symbol = ${symbol} 
      FOR UPDATE
    `;
    
    if (!positions || positions.length === 0) {
      if (portfolio.isMarginEnabled) return null;
      throw new Error(`Insufficient quantity: No position found for ${symbol}`);
    }
    
    const position = await tx.position.findUniqueOrThrow({ where: { id: positions[0].id } });
    const availableQty = new Prisma.Decimal(position.quantity).minus(position.lockedQuantity);
    
    if (availableQty.lt(requiredQuantity) && !portfolio.isMarginEnabled) {
      throw new Error(`Insufficient quantity: Required ${requiredQuantity.toString()}, Available ${availableQty.toString()}`);
    }
    return position;
  }

  static async lockPosition(tx: Prisma.TransactionClient, portfolioId: string, symbol: string, quantityToLock: Prisma.Decimal): Promise<Position> {
    const position = await this.checkPosition(tx, portfolioId, symbol, quantityToLock);
    if (!position) {
      // Must be margin-enabled if checkPosition returned null
      return tx.position.create({
        data: {
          portfolioId,
          symbol,
          quantity: 0,
          lockedQuantity: quantityToLock,
          averageEntryPrice: 0,
          status: PositionStatus.OPEN
        }
      });
    }
    return tx.position.update({
      where: { id: position.id },
      data: { lockedQuantity: new Prisma.Decimal(position.lockedQuantity).plus(quantityToLock) }
    });
  }

  static async adjustOnBuy(
    tx: Prisma.TransactionClient,
    portfolioId: string,
    symbol: string,
    fillQuantity: Prisma.Decimal,
    fillPrice: Prisma.Decimal
  ): Promise<{ position: Position, realizedPnl: Prisma.Decimal }> {
    let position = await tx.position.findUnique({
      where: { portfolioId_symbol: { portfolioId, symbol } }
    });

    let newQuantity = fillQuantity;
    let newAverage = fillPrice;
    let realizedPnl = new Prisma.Decimal(0);

    if (!position) {
      position = await tx.position.create({
        data: {
          portfolioId,
          symbol,
          quantity: newQuantity,
          averageEntryPrice: newAverage,
          status: PositionStatus.OPEN
        }
      });
    } else {
      const currentQty = new Prisma.Decimal(position.quantity);
      const currentAvg = new Prisma.Decimal(position.averageEntryPrice);
      newQuantity = currentQty.plus(fillQuantity);

      if (currentQty.gte(0)) {
        // LONG increasing
        if (currentQty.eq(0)) {
           newAverage = fillPrice;
        } else {
           const totalCostOld = currentQty.mul(currentAvg);
           const totalCostNew = fillQuantity.mul(fillPrice);
           newAverage = (totalCostOld.plus(totalCostNew)).div(newQuantity);
        }
      } else {
        // SHORT covering
        const absQty = currentQty.abs();
        if (fillQuantity.lte(absQty)) {
          // Partial or Full Cover
          realizedPnl = (currentAvg.minus(fillPrice)).mul(fillQuantity);
          newAverage = currentAvg;
        } else {
          // Zero crossing (Short to Long)
          const coverQty = absQty;
          realizedPnl = (currentAvg.minus(fillPrice)).mul(coverQty);
          // New position is long, its entry price is the execution price
          newAverage = fillPrice;
        }
      }

      const newStatus = newQuantity.eq(0) ? PositionStatus.CLOSED : PositionStatus.OPEN;

      position = await tx.position.update({
        where: { id: position.id },
        data: {
          quantity: newQuantity,
          averageEntryPrice: newAverage,
          realizedPnl: new Prisma.Decimal(position.realizedPnl).plus(realizedPnl),
          status: newStatus
        }
      });
    }

    const eventType = position.status === PositionStatus.CLOSED ? 'POSITION_CLOSED' : 'POSITION_UPDATED';
    
    await tx.outboxEvent.create({
      data: {
        type: eventType,
        aggregateType: 'POSITION',
        aggregateId: position.id,
        payload: {
          positionId: position.id,
          portfolioId: position.portfolioId,
          symbol: position.symbol,
          quantity: position.quantity.toString(),
          averageEntryPrice: position.averageEntryPrice.toString(),
          realizedPnl: position.realizedPnl.toString(),
          status: position.status
        }
      }
    });

    return { position, realizedPnl };
  }

  static async adjustOnSell(
    tx: Prisma.TransactionClient,
    portfolioId: string,
    symbol: string,
    sellQuantity: Prisma.Decimal,
    sellPrice: Prisma.Decimal
  ): Promise<{ position: Position, realizedPnl: Prisma.Decimal }> {
    const position = await tx.position.findUniqueOrThrow({
      where: { portfolioId_symbol: { portfolioId, symbol } }
    });

    const currentQty = new Prisma.Decimal(position.quantity);
    const currentAvg = new Prisma.Decimal(position.averageEntryPrice);
    
    if (new Prisma.Decimal(position.lockedQuantity).lt(sellQuantity)) {
      throw new Error(`Insufficient locked quantity: Required ${sellQuantity.toString()}, Available ${position.lockedQuantity.toString()}`);
    }

    let newQuantity = currentQty.minus(sellQuantity);
    let newAverage = currentAvg;
    let realizedPnl = new Prisma.Decimal(0);

    if (currentQty.lte(0)) {
      // SHORT increasing
      if (currentQty.eq(0)) {
         newAverage = sellPrice;
      } else {
         const absQty = currentQty.abs();
         const totalCostOld = absQty.mul(currentAvg);
         const totalCostNew = sellQuantity.mul(sellPrice);
         newAverage = (totalCostOld.plus(totalCostNew)).div(absQty.plus(sellQuantity));
      }
    } else {
      // LONG closing
      if (sellQuantity.lte(currentQty)) {
        // Partial or Full Close
        realizedPnl = (sellPrice.minus(currentAvg)).mul(sellQuantity);
        newAverage = currentAvg;
      } else {
        // Zero crossing (Long to Short)
        const closeQty = currentQty;
        realizedPnl = (sellPrice.minus(currentAvg)).mul(closeQty);
        // New position is short, its entry price is the execution price
        newAverage = sellPrice;
      }
    }

    const newLockedQuantity = new Prisma.Decimal(position.lockedQuantity).minus(sellQuantity);
    const newStatus = newQuantity.eq(0) ? PositionStatus.CLOSED : PositionStatus.OPEN;

    const updatedPosition = await tx.position.update({
      where: { id: position.id },
      data: {
        quantity: newQuantity,
        lockedQuantity: newLockedQuantity,
        averageEntryPrice: newAverage,
        realizedPnl: new Prisma.Decimal(position.realizedPnl).plus(realizedPnl),
        status: newStatus
      }
    });

    const eventType = newStatus === PositionStatus.CLOSED ? 'POSITION_CLOSED' : 'POSITION_UPDATED';

    await tx.outboxEvent.create({
      data: {
        type: eventType,
        aggregateType: 'POSITION',
        aggregateId: position.id,
        payload: {
          positionId: updatedPosition.id,
          portfolioId: updatedPosition.portfolioId,
          symbol: updatedPosition.symbol,
          quantity: updatedPosition.quantity.toString(),
          averageEntryPrice: updatedPosition.averageEntryPrice.toString(),
          realizedPnl: updatedPosition.realizedPnl.toString(),
          status: updatedPosition.status
        }
      }
    });

    return { position: updatedPosition, realizedPnl };
  }
}
