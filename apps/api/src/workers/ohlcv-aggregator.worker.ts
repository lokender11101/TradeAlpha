import { Redis } from 'ioredis';
import { PrismaClient, Prisma } from '@prisma/client';
import pino from 'pino';
import crypto from 'crypto';
import { defaultMarketSessionService } from '../services/market-session.service';

const logger = pino({
  name: 'OhlcvAggregatorWorker',
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
});

export class OhlcvAggregatorWorker {
  private subscriber: Redis;
  private publisher: Redis;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redisUrl: string
  ) {
    this.subscriber = new Redis(this.redisUrl);
    this.publisher = new Redis(this.redisUrl);
  }

  public async start(): Promise<void> {
    this.subscriber.on('pmessage', this.handleMessage.bind(this));
    await this.subscriber.psubscribe('market:tick:*');
    logger.info('OHLCV Aggregator Worker started, listening to market:tick:*');
  }

  public async stop(): Promise<void> {
    await this.subscriber.punsubscribe('market:tick:*');
    await this.subscriber.quit();
    await this.publisher.quit();
    logger.info('OHLCV Aggregator Worker stopped');
  }

  private async handleMessage(pattern: string, channel: string, message: string): Promise<void> {
    try {
      const payload = JSON.parse(message);
      const { tickId, symbol, price, volume, timestamp } = payload;
      
      if (!tickId || !symbol || !price || !volume || !timestamp) return;

      const tickTime = new Date(timestamp);
      
      // Enforce market session boundary
      const sessionState = defaultMarketSessionService.getSessionOriginState(tickTime);
      if (sessionState === 'CLOSED') {
        return; // Ignore ticks outside market hours
      }

      // Convert volume and price ensuring no JS floating point arithmetic
      const priceDec = new Prisma.Decimal(price);
      const volumeDec = new Prisma.Decimal(volume);

      // Canonical 1m candle boundary
      const candleStart = new Date(tickTime);
      candleStart.setSeconds(0, 0);

      const candleId = crypto.randomUUID();

      // Close any previous open candles for this symbol
      await this.prisma.$executeRaw`
        UPDATE "market_candles" 
        SET "is_closed" = true 
        WHERE "symbol" = ${symbol} 
          AND "timeframe" = '1m' 
          AND "timestamp" < ${candleStart} 
          AND "is_closed" = false;
      `;

      // Atomic aggregation
      // 1. Insert MarketTickReceipt ON CONFLICT DO NOTHING
      // 2. Only if inserted, UPSERT the candle
      const updatedRows: any[] = await this.prisma.$queryRaw`
        WITH inserted_receipt AS (
          INSERT INTO "market_tick_receipts" ("tick_id", "symbol", "timestamp", "processed_at")
          VALUES (${tickId}, ${symbol}, ${tickTime}, NOW())
          ON CONFLICT ("tick_id") DO NOTHING
          RETURNING "tick_id"
        )
        INSERT INTO "market_candles" (
          "id", "symbol", "timeframe", "timestamp", 
          "open", "high", "low", "close", "volume", 
          "is_closed", "last_tick_timestamp", "updated_at"
        )
        SELECT 
          ${candleId}, ${symbol}, '1m', ${candleStart}, 
          ${priceDec}, ${priceDec}, ${priceDec}, ${priceDec}, ${volumeDec}, 
          false, ${tickTime}, NOW()
        FROM inserted_receipt
        ON CONFLICT ("symbol", "timeframe", "timestamp") DO UPDATE SET
          high = GREATEST("market_candles".high, EXCLUDED.high),
          low = LEAST("market_candles".low, EXCLUDED.low),
          close = CASE WHEN EXCLUDED.last_tick_timestamp >= "market_candles".last_tick_timestamp THEN EXCLUDED.close ELSE "market_candles".close END,
          volume = "market_candles".volume + EXCLUDED.volume,
          last_tick_timestamp = GREATEST("market_candles".last_tick_timestamp, EXCLUDED.last_tick_timestamp),
          updated_at = NOW()
        RETURNING *;
      `;

      if (Array.isArray(updatedRows) && updatedRows.length > 0) {
        const candle = updatedRows[0];
        
        // Publish MARKET_CANDLE update for WebSockets
        const wsPayload = JSON.stringify({
          type: 'MARKET_CANDLE',
          payload: {
            symbol: candle.symbol,
            timeframe: candle.timeframe,
            timestamp: candle.timestamp.toISOString(),
            open: candle.open.toString(),
            high: candle.high.toString(),
            low: candle.low.toString(),
            close: candle.close.toString(),
            volume: candle.volume.toString(),
            isClosed: candle.is_closed
          }
        });
        
        await this.publisher.publish(`market:candle:${symbol}`, wsPayload);
      }
      
    } catch (error) {
      logger.error({ err: error, message }, 'Error processing tick in OHLCV Aggregator');
    }
  }
}
