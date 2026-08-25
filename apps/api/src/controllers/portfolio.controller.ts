import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { PriceCacheService } from '../services/price-cache.service';
import { PortfolioValuationService } from '../services/portfolio-valuation.service';
import Redis from 'ioredis';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
const priceCache = new PriceCacheService(redis);
const valuationService = new PortfolioValuationService(prisma, priceCache);

export class PortfolioController {
  static async getPortfolio(req: AuthenticatedRequest, res: Response) {
    try {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      const portfolioId = req.params.portfolioId as string;
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      const portfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId } });
      if (!portfolio) {
        return res.status(404).json({ error: 'Portfolio not found' });
      }
      if (portfolio.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      
      const valuation = await valuationService.getValuation(portfolio.id);
      
      res.status(200).json({
        id: portfolio.id,
        userId: portfolio.userId,
        ...valuation
      });
    } catch (error) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  static async getPositions(req: AuthenticatedRequest, res: Response) {
    try {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      const portfolioId = req.params.portfolioId as string;
      
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const portfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId } });
      
      if (!portfolio) {
        return res.status(404).json({ error: 'Portfolio not found' });
      }

      if (portfolio.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to this portfolio' });
      }

      const positions = await prisma.position.findMany({
        where: { portfolioId }
      });

      const positionsWithValuation = await Promise.all(positions.map(async (pos) => {
        const { price, isStale, updatedAt } = await priceCache.getLatestPrice(pos.symbol);
        
        let unrealizedPnl = null;
        let totalValue = null;

        if (!isStale && price) {
          const currentPriceNum = parseFloat(price);
          const avgEntryNum = pos.averageEntryPrice.toNumber();
          const quantityNum = pos.quantity.toNumber();

          unrealizedPnl = ((currentPriceNum - avgEntryNum) * quantityNum).toFixed(4);
          totalValue = (currentPriceNum * quantityNum).toFixed(4);
        }

        return {
          id: pos.id,
          symbol: pos.symbol,
          quantity: pos.quantity.toString(),
          lockedQuantity: pos.lockedQuantity.toString(),
          averageEntryPrice: pos.averageEntryPrice.toString(),
          realizedPnl: pos.realizedPnl.toString(),
          status: pos.status,
          currentPrice: price,
          priceUpdatedAt: updatedAt?.toISOString() || null,
          isStale,
          unrealizedPnl,
          totalValue
        };
      }));

      res.status(200).json(positionsWithValuation);
    } catch (error: any) {
      res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
    }
  }

  static async getHistory(req: AuthenticatedRequest, res: Response) {
    try {
      const portfolioId = req.params.portfolioId as string;
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const portfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId } });
      
      if (!portfolio) {
        return res.status(404).json({ error: 'Portfolio not found' });
      }

      if (portfolio.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const limit = parseInt(req.query.limit as string) || 30; // default 30 days
      const daysStr = req.query.days as string;
      
      let fromDate: Date | undefined;
      if (daysStr) {
        const days = parseInt(daysStr);
        fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - days);
      }

      const whereClause: any = { portfolioId };
      if (fromDate) {
        whereClause.snapshotDate = { gte: fromDate };
      }

      const history = await prisma.portfolioSnapshot.findMany({
        where: whereClause,
        orderBy: { snapshotDate: 'asc' },
        take: limit
      });

      const formatted = history.map(h => ({
        date: h.snapshotDate.toISOString(),
        cash: h.totalCash.toString(),
        marketValue: h.marketValue.toString(),
        nav: h.totalNav.toString(),
        realizedPnl: h.realizedPnl.toString(),
        unrealizedPnl: h.unrealizedPnl.toString(),
      }));

      res.status(200).json(formatted);
    } catch (error: any) {
      res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } });
    }
  }
}
