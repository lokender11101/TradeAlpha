import { PrismaClient, PositionStatus } from '@prisma/client';
import { PriceCacheService } from './price-cache.service';
import { Prisma } from '@prisma/client';

export type PortfolioValuation = {
  totalCash: string;
  lockedCash: string;
  availableCash: string;
  marketValue: string;
  unrealizedPnl: string;
  realizedPnl: string;
  totalNav: string;
  isStale: boolean;
};

export class PortfolioValuationService {
  constructor(private prisma: PrismaClient, private priceCache: PriceCacheService) {}

  async getValuation(portfolioId: string): Promise<PortfolioValuation> {
    const portfolio = await this.prisma.portfolio.findUnique({
      where: { id: portfolioId },
      include: { positions: true }
    });

    if (!portfolio) {
      throw new Error('Portfolio not found');
    }

    const totalCash = new Prisma.Decimal(portfolio.totalCash);
    const lockedCash = new Prisma.Decimal(portfolio.lockedCash);
    const availableCash = totalCash.minus(lockedCash);

    let marketValue = new Prisma.Decimal(0);
    let unrealizedPnl = new Prisma.Decimal(0);
    let realizedPnl = new Prisma.Decimal(0);
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

      const currentPriceNum = price ? new Prisma.Decimal(price) : pos.averageEntryPrice;
      const quantityNum = new Prisma.Decimal(pos.quantity);
      const avgEntryNum = new Prisma.Decimal(pos.averageEntryPrice);

      const posMarketValue = currentPriceNum.mul(quantityNum);
      const posUnrealizedPnl = currentPriceNum.minus(avgEntryNum).mul(quantityNum);

      marketValue = marketValue.plus(posMarketValue);
      unrealizedPnl = unrealizedPnl.plus(posUnrealizedPnl);
    }

    const totalNav = totalCash.plus(marketValue);

    return {
      totalCash: totalCash.toFixed(4),
      lockedCash: lockedCash.toFixed(4),
      availableCash: availableCash.toFixed(4),
      marketValue: marketValue.toFixed(4),
      unrealizedPnl: unrealizedPnl.toFixed(4),
      realizedPnl: realizedPnl.toFixed(4),
      totalNav: totalNav.toFixed(4),
      isStale
    };
  }
}
