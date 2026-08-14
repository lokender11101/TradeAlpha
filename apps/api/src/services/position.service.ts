import { createEnvelope } from '../utils/envelope';
import { Prisma, Position, PositionStatus } from '@prisma/client';

export class PositionService {
  static async checkPosition(tx: Prisma.TransactionClient, portfolioId: string, symbol: string, requiredQuantity: Prisma.Decimal): Promise<Position> {
    const positions = await tx.$queryRaw<{id: string}[]>`
      SELECT id FROM positions 
      WHERE portfolio_id = ${portfolioId} AND symbol = ${symbol} 
      FOR UPDATE
    `;
    if (!positions || positions.length === 0) throw new Error(`Insufficient quantity: No position found for ${symbol}`);
    
    const position = await tx.position.findUniqueOrThrow({ where: { id: positions[0].id } });
    const availableQty = new Prisma.Decimal(position.quantity).minus(position.lockedQuantity);
    if (availableQty.lt(requiredQuantity)) throw new Error(`Insufficient quantity: Required ${requiredQuantity.toString()}, Available ${availableQty.toString()}`);
    return position;
  }

  static async lockPosition(tx: Prisma.TransactionClient, portfolioId: string, symbol: string, quantityToLock: Prisma.Decimal): Promise<Position> {
    const position = await this.checkPosition(tx, portfolioId, symbol, quantityToLock);
    return tx.position.update({
      where: { id: position.id },
      data: { lockedQuantity: new Prisma.Decimal(position.lockedQuantity).plus(quantityToLock) }
    });
  }

  /**
   * Processes a buy fill against a position, calculating Weighted Average Cost (WAC).
   * Emits POSITION_OPENED or POSITION_UPDATED.
   */
  static async adjustOnBuy(
    tx: Prisma.TransactionClient,
    portfolioId: string,
    symbol: string,
    fillQuantity: Prisma.Decimal,
    fillPrice: Prisma.Decimal
  ): Promise<Position> {
    let position = await tx.position.findUnique({
      where: { portfolioId_symbol: { portfolioId, symbol } }
    });

    const isNew = !position || position.status === PositionStatus.CLOSED || position.quantity.eq(0);

    let newAverage = fillPrice;
    let newQuantity = fillQuantity;

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
      if (isNew) {
        newAverage = fillPrice;
      } else {
        const oldQty = position.quantity;
        const totalCostOld = oldQty.mul(position.averageEntryPrice);
        const totalCostNew = fillQuantity.mul(fillPrice);
        newAverage = (totalCostOld.plus(totalCostNew)).div(oldQty.plus(fillQuantity));
      }

      newQuantity = position.quantity.plus(fillQuantity);

      position = await tx.position.update({
        where: { id: position.id },
        data: {
          quantity: newQuantity,
          averageEntryPrice: newAverage,
          status: PositionStatus.OPEN
        }
      });
    }

    const eventType = isNew ? 'POSITION_OPENED' : 'POSITION_UPDATED';
    
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

    return position;
  }

  /**
   * Processes a sell fill against a position, calculating Realized PnL and consuming reserved lockedQuantity.
   * Emits POSITION_UPDATED or POSITION_CLOSED.
   */
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

    if (position.quantity.lt(sellQuantity)) {
      throw new Error(`Insufficient quantity: Required ${sellQuantity.toString()}, Available ${position.quantity.toString()}`);
    }
    if (position.lockedQuantity.lt(sellQuantity)) {
      throw new Error(`Insufficient locked quantity: Required ${sellQuantity.toString()}, Available ${position.lockedQuantity.toString()}`);
    }

    const fillRealizedPnl = (sellPrice.minus(position.averageEntryPrice)).mul(sellQuantity);
    
    const newQuantity = position.quantity.minus(sellQuantity);
    const newLockedQuantity = position.lockedQuantity.minus(sellQuantity);
    const newRealizedPnl = position.realizedPnl.plus(fillRealizedPnl);
    
    const newStatus = newQuantity.eq(0) ? PositionStatus.CLOSED : PositionStatus.OPEN;

    const updatedPosition = await tx.position.update({
      where: { id: position.id },
      data: {
        quantity: newQuantity,
        lockedQuantity: newLockedQuantity,
        realizedPnl: newRealizedPnl,
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

    return { position: updatedPosition, realizedPnl: fillRealizedPnl };
  }
}
