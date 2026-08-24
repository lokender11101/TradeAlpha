import { getLiquidityProfile } from '../engine/liquidity.config';
import { Request, Response } from 'express';
import { defaultMarketSessionService } from '../services/market-session.service';
import { MarketCandleService, Timeframe } from '../services/market-candle.service';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const marketCandleService = new MarketCandleService(prisma);

export class MarketController {
  public static getStatus(req: Request, res: Response) {
    try {
      const status = defaultMarketSessionService.getStatus();
      res.status(200).json(status);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch market status' });
    }
  }

  public static async getCandles(req: Request, res: Response) {
    try {
      const { symbol, timeframe, limit } = req.query;

      if (!symbol || typeof symbol !== 'string') {
        return res.status(400).json({ error: 'Valid symbol is required' });
      }

      if (!timeframe || !['1m', '5m', '15m', '1h', '1d'].includes(timeframe as string)) {
        return res.status(400).json({ error: 'Valid timeframe is required (1m, 5m, 15m, 1h, 1d)' });
      }

      const parsedLimit = limit ? parseInt(limit as string, 10) : 100;
      if (isNaN(parsedLimit) || parsedLimit <= 0) {
        return res.status(400).json({ error: 'Limit must be a positive integer' });
      }

      const candles = await marketCandleService.getCandles(symbol, timeframe as Timeframe, parsedLimit);
      return res.status(200).json(candles);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch market candles' });
    }
  }

  public static getExecutionProfile(req: Request, res: Response) {
    try {
      const { symbol } = req.query;
      if (!symbol || typeof symbol !== 'string') {
        return res.status(400).json({ error: 'Valid symbol is required' });
      }

      const profile = getLiquidityProfile(symbol);
      return res.status(200).json({
        symbol: profile.symbol,
        baseSpread: profile.baseSpread,
        availableDepth: profile.availableDepth,
        slippageFactor: profile.slippageFactor
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch execution profile' });
    }
  }
}
