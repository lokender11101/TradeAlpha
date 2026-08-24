import { PrismaClient, Prisma } from '@prisma/client';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '1d';

export interface CandleResponse {
  symbol: string;
  timeframe: string;
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  isClosed: boolean;
}

export class MarketCandleService {
  private readonly TIMEZONE = 'Asia/Kolkata';

  constructor(private readonly prisma: PrismaClient) {}

  public async getCandles(symbol: string, timeframe: Timeframe, limit: number = 100): Promise<CandleResponse[]> {
    const cappedLimit = Math.min(limit, 1000);

    // Calculate base 1m limit needed to satisfy the requested timeframe
    let multiplier = 1;
    switch (timeframe) {
      case '5m': multiplier = 5; break;
      case '15m': multiplier = 15; break;
      case '1h': multiplier = 60; break;
      case '1d': multiplier = 375; break; // 09:15 to 15:30 is 6h15m = 375 mins
    }
    const baseLimit = cappedLimit * multiplier;

    // Fetch the canonical 1m candles
    const baseCandles = await this.prisma.marketCandle.findMany({
      where: { symbol, timeframe: '1m' },
      orderBy: { timestamp: 'desc' },
      take: baseLimit,
    });

    if (baseCandles.length === 0) {
      return [];
    }

    if (timeframe === '1m') {
      return baseCandles.map(c => this.mapToResponse(c, c.timestamp, timeframe, c.isClosed)).reverse();
    }

    return this.aggregateCandles(baseCandles.reverse(), timeframe).slice(-cappedLimit);
  }

  private aggregateCandles(candles: any[], timeframe: Timeframe): CandleResponse[] {
    const grouped = new Map<string, any[]>();

    for (const candle of candles) {
      const groupKey = this.getBucketBoundary(candle.timestamp, timeframe);
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, []);
      }
      grouped.get(groupKey)!.push(candle);
    }

    const result: CandleResponse[] = [];
    for (const [groupKey, group] of grouped.entries()) {
      const open = group[0].open;
      let high = group[0].high;
      let low = group[0].low;
      const close = group[group.length - 1].close;
      let volume = new Prisma.Decimal(0);
      let isClosed = true; // Assume true, override if any unclosed candle is the last one in the group

      for (let i = 0; i < group.length; i++) {
        const c = group[i];
        if (c.high.gt(high)) high = c.high;
        if (c.low.lt(low)) low = c.low;
        volume = volume.add(c.volume);
        
        // If this is the most recent (last) candle in the bucket and it's open, the bucket is open
        if (i === group.length - 1 && !c.isClosed) {
          isClosed = false;
        }
      }

      const timestamp = new Date(groupKey);

      result.push({
        symbol: group[0].symbol,
        timeframe,
        timestamp: timestamp.toISOString(),
        open: open.toString(),
        high: high.toString(),
        low: low.toString(),
        close: close.toString(),
        volume: volume.toString(),
        isClosed
      });
    }

    return result;
  }

  private getBucketBoundary(date: Date, timeframe: Timeframe): string {
    const zoned = toZonedTime(date, this.TIMEZONE);
    
    if (timeframe === '1d') {
      // Snap to 09:15:00 of the given day
      const dateStr = formatInTimeZone(date, this.TIMEZONE, 'yyyy-MM-dd');
      return new Date(`${dateStr}T09:15:00.000+05:30`).toISOString();
    }

    // For intraday, we calculate minutes since 09:15
    const hours = zoned.getHours();
    const minutes = zoned.getMinutes();
    const minutesSinceStart = (hours * 60 + minutes) - (9 * 60 + 15);
    
    // Fallback if before 09:15 (should not happen for valid market hours)
    const effMinutes = minutesSinceStart >= 0 ? minutesSinceStart : 0;
    
    let bucketSize = 1;
    if (timeframe === '5m') bucketSize = 5;
    else if (timeframe === '15m') bucketSize = 15;
    else if (timeframe === '1h') bucketSize = 60;

    const bucketStartMinutes = Math.floor(effMinutes / bucketSize) * bucketSize;
    
    const dateStr = formatInTimeZone(date, this.TIMEZONE, 'yyyy-MM-dd');
    const startHour = Math.floor((9 * 60 + 15 + bucketStartMinutes) / 60);
    const startMin = (9 * 60 + 15 + bucketStartMinutes) % 60;
    
    const hh = startHour.toString().padStart(2, '0');
    const mm = startMin.toString().padStart(2, '0');
    
    return new Date(`${dateStr}T${hh}:${mm}:00.000+05:30`).toISOString();
  }

  private mapToResponse(candle: any, timestamp: Date, timeframe: string, isClosed: boolean): CandleResponse {
    return {
      symbol: candle.symbol,
      timeframe,
      timestamp: timestamp.toISOString(),
      open: candle.open.toString(),
      high: candle.high.toString(),
      low: candle.low.toString(),
      close: candle.close.toString(),
      volume: candle.volume.toString(),
      isClosed
    };
  }
}
