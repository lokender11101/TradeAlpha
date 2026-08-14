import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { PriceCacheService } from '../services/price-cache.service';
import Redis from 'ioredis';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
const priceCache = new PriceCacheService(redis);

export class PortfolioController {
  static async getPortfolio(req: AuthenticatedRequest, res: Response) {
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
      
      res.status(200).json(portfolio);
    } catch (error) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  static async getPositions(req: AuthenticatedRequest, res: Response) {
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
}
