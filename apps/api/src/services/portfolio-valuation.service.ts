import { PrismaClient, PositionStatus, OrderSide } from '@prisma/client';
import { PriceCacheService } from './price-cache.service';
import { Prisma } from '@prisma/client';
import { calculateExecutablePrice, getLiquidityProfile } from '../engine/liquidity.config';

export type PortfolioValuation = {
  totalCash: string;
  lockedCash: string;
  availableCash: string;
  marketValue: string;
  unrealizedPnl: string;
  realizedPnl: string;
  totalNav: string;
  
  // Phase 9.1 Additions
  isMarginEnabled: boolean;
  lockedMargin: string;
  longMarketValue: string;
  shortLiabilityValue: string;
  grossExposure: string;
  initialMargin: string;
  maintenanceMargin: string;
  usedMargin: string;
  freeMargin: string;
  marginLevel: string | null;
  buyingPower: string;
  marginStatus: "NORMAL" | "MARGIN_CALL" | "FORCED_LIQUIDATION" | "FORCED_LIQUIDATION";
  
  isStale: boolean;
};

export class PortfolioValuationService {
  private readonly IM_RATE = new Prisma.Decimal('0.50');
  private readonly MM_RATE = new Prisma.Decimal('0.25');

  constructor(private prisma: PrismaClient, private priceCache: PriceCacheService) {}

  async getValuation(portfolioId: string, tx?: Prisma.TransactionClient): Promise<PortfolioValuation> {
    const client = tx || this.prisma;
    const portfolio = await client.portfolio.findUnique({
      where: { id: portfolioId },
      include: { positions: true }
    });

    if (!portfolio) {
      throw new Error('Portfolio not found');
    }

    const totalCash = new Prisma.Decimal(portfolio.totalCash);
    const lockedCash = new Prisma.Decimal(portfolio.lockedCash);
    const lockedMargin = new Prisma.Decimal(portfolio.lockedMargin);
    const availableCash = totalCash.minus(lockedCash);

    let longMarketValue = new Prisma.Decimal(0);
    let shortLiabilityValue = new Prisma.Decimal(0);
    let unrealizedPnl = new Prisma.Decimal(0);
    let realizedPnl = new Prisma.Decimal(0);
    let initialMargin = new Prisma.Decimal(0);
    let maintenanceMargin = new Prisma.Decimal(0);
    let isStale = false;

    for (const pos of portfolio.positions) {
      realizedPnl = realizedPnl.plus(new Prisma.Decimal(pos.realizedPnl));

      if (pos.status === PositionStatus.CLOSED || pos.quantity.eq(0)) {
        continue;
      }

      const { price, isStale: priceIsStale } = await this.priceCache.getLatestPrice(pos.symbol);
      
      if (priceIsStale || !price) {
        isStale = true;
      }

      const refPriceNum = price ? new Prisma.Decimal(price) : pos.averageEntryPrice;
      const quantityNum = new Prisma.Decimal(pos.quantity);
      const avgEntryNum = new Prisma.Decimal(pos.averageEntryPrice);
      
      const liquidityProfile = getLiquidityProfile(pos.symbol);

      if (quantityNum.gt(0)) {
        // LONG Position: Use Executable BID
        const bidPrice = calculateExecutablePrice(OrderSide.SELL, refPriceNum, liquidityProfile, new Prisma.Decimal(0));
        const posMarketValue = bidPrice.mul(quantityNum);
        const posUnrealizedPnl = bidPrice.minus(avgEntryNum).mul(quantityNum);
        
        longMarketValue = longMarketValue.plus(posMarketValue);
        unrealizedPnl = unrealizedPnl.plus(posUnrealizedPnl);
        
        initialMargin = initialMargin.plus(posMarketValue.mul(this.IM_RATE));
        maintenanceMargin = maintenanceMargin.plus(posMarketValue.mul(this.MM_RATE));
        
      } else if (quantityNum.lt(0)) {
        // SHORT Position: Use Executable ASK
        const absQty = quantityNum.abs();
        const askPrice = calculateExecutablePrice(OrderSide.BUY, refPriceNum, liquidityProfile, new Prisma.Decimal(0));
        const posLiabilityValue = askPrice.mul(absQty);
        
        // PnL: (Entry - Exit) * Qty
        const posUnrealizedPnl = avgEntryNum.minus(askPrice).mul(absQty);
        
        shortLiabilityValue = shortLiabilityValue.plus(posLiabilityValue);
        unrealizedPnl = unrealizedPnl.plus(posUnrealizedPnl);
        
        initialMargin = initialMargin.plus(posLiabilityValue.mul(this.IM_RATE));
        maintenanceMargin = maintenanceMargin.plus(posLiabilityValue.mul(this.MM_RATE));
      }
    }

    const netMarketValue = longMarketValue.minus(shortLiabilityValue);
    const grossExposure = longMarketValue.plus(shortLiabilityValue);
    
    // Equity = Total Cash + LMV - SMV
    const equity = totalCash.plus(netMarketValue);
    
    const usedMargin = initialMargin;
    const freeMargin = equity.minus(usedMargin).minus(lockedMargin);
    const buyingPower = freeMargin.gt(0) ? freeMargin.dividedBy(this.IM_RATE) : new Prisma.Decimal(0);
    
    let marginLevel: string | null = null;
    let marginStatus: "NORMAL" | "MARGIN_CALL" | "FORCED_LIQUIDATION" = "NORMAL";

    if (maintenanceMargin.gt(0)) {
      const ml = equity.dividedBy(maintenanceMargin).mul(100);
      marginLevel = ml.toFixed(4);
      if (ml.lt(100)) marginStatus = "FORCED_LIQUIDATION";
      else if (ml.lt(120)) marginStatus = "MARGIN_CALL";

    }

    return {
      totalCash: totalCash.toFixed(4),
      lockedCash: lockedCash.toFixed(4),
      availableCash: availableCash.toFixed(4),
      marketValue: netMarketValue.toFixed(4), // Legacy field, mapping to Net Market Value
      unrealizedPnl: unrealizedPnl.toFixed(4),
      realizedPnl: realizedPnl.toFixed(4),
      totalNav: equity.toFixed(4), // Equity
      
      isMarginEnabled: portfolio.isMarginEnabled,
      lockedMargin: lockedMargin.toFixed(4),
      longMarketValue: longMarketValue.toFixed(4),
      shortLiabilityValue: shortLiabilityValue.toFixed(4),
      grossExposure: grossExposure.toFixed(4),
      initialMargin: initialMargin.toFixed(4),
      maintenanceMargin: maintenanceMargin.toFixed(4),
      usedMargin: usedMargin.toFixed(4),
      freeMargin: freeMargin.toFixed(4),
      marginLevel,
      buyingPower: buyingPower.toFixed(4),
      marginStatus,

      
      isStale
    };
  }
}
