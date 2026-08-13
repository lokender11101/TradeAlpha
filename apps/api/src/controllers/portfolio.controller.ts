import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { PriceCacheService } from '../services/price-cache.service';
import Redis from 'ioredis';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
const priceCache = new PriceCacheService(redis);

export class PortfolioController {
  static async getPositions(req: Request, res: Response) {
    try {
      const portfolioId = req.params.portfolioId as string;
      
      // In a real app with auth, req.user.id would be verified against portfolio.userId here.
      // Mocking the check per requirements: portfolio.userId === req.user.id
      const userId = (req as any).user?.id || (req.headers['x-user-id'] as string);

      const portfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId } });
      
      if (!portfolio) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Portfolio not found' } });
      }

      if (userId && portfolio.userId !== userId) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Unauthorized' } });
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
