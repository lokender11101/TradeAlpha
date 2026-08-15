import { Request, Response } from 'express';
import { defaultMarketSessionService } from '../services/market-session.service';

export class MarketController {
  public static getStatus(req: Request, res: Response) {
    try {
      const status = defaultMarketSessionService.getStatus();
      res.status(200).json(status);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch market status' });
    }
  }
}
