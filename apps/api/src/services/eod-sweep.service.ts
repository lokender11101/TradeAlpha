import { PrismaClient, OrderStatus } from '@prisma/client';
import Redis from 'ioredis';
import pino from 'pino';
import { defaultMarketSessionService } from './market-session.service';
import { OrderService } from './order.service';
import { formatInTimeZone } from 'date-fns-tz';
import { defaultTimeProvider } from './time.provider';
import { Emitter } from '@socket.io/redis-emitter';
import { EventEnvelope } from '../websocket';
import * as crypto from 'crypto';
import { PortfolioValuationService } from './portfolio-valuation.service';
import { PriceCacheService } from './price-cache.service';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, ignore: 'pid,hostname' }
  }
});

export class EodSweepService {
  private readonly redis: Redis;
  private readonly prisma: PrismaClient;
  private readonly orderService: OrderService;
  private readonly emitter: Emitter;
  private readonly priceCache: PriceCacheService;
  private readonly valuationService: PortfolioValuationService;
  private interval?: NodeJS.Timeout;

  constructor(redisUrl: string, prisma: PrismaClient) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.prisma = prisma;
    this.orderService = new OrderService(this.prisma);
    this.emitter = new Emitter(this.redis);
    this.priceCache = new PriceCacheService(this.redis);
    this.valuationService = new PortfolioValuationService(this.prisma, this.priceCache);
  }

  public start() {
    this.interval = setInterval(() => this.tick(), 1000);
    logger.info('[EodSweepService] Started EOD sweep watcher');
  }

  public stop() {
    if (this.interval) clearInterval(this.interval);
  }

  private async tick() {
    const now = defaultTimeProvider.now();
    const timeStr = formatInTimeZone(now, 'Asia/Kolkata', 'HH:mm:ss');
    
    if (timeStr === '15:30:00') {
      const dateStr = formatInTimeZone(now, 'Asia/Kolkata', 'yyyy-MM-dd');
      const leaseKey = `eod:sweep:global:${dateStr}`;
      
      const acquired = await this.redis.set(leaseKey, 'locked', 'EX', 60, 'NX');
      
      if (acquired) {
        logger.info('[EodSweepService] Acquired EOD sweep lease. Executing transition...');
        await this.executeSweep();
        await this.snapshotPortfolios(now);
        this.emitSessionStatus('CLOSED');
      }
    } else if (timeStr === '09:15:00') {
      const dateStr = formatInTimeZone(now, 'Asia/Kolkata', 'yyyy-MM-dd');
      const leaseKey = `bod:sweep:global:${dateStr}`;
      
      const acquired = await this.redis.set(leaseKey, 'locked', 'EX', 60, 'NX');
      if (acquired) {
        logger.info('[EodSweepService] Acquired BOD transition lease. Emitting OPEN status...');
        this.emitSessionStatus('OPEN');
      }
    }
  }

  private async executeSweep() {
    try {
      const activeOrders = await this.prisma.order.findMany({
        where: {
          status: { in: [OrderStatus.ACCEPTED, OrderStatus.PENDING, OrderStatus.PARTIALLY_FILLED] }
        }
      });

      logger.info({ count: activeOrders.length }, '[EodSweepService] Found active orders to expire');

      let expiredCount = 0;
      for (const order of activeOrders) {
        try {
          await this.orderService.expireOrder(order.id);
          expiredCount++;
        } catch (err) {
          logger.error({ err, orderId: order.id }, '[EodSweepService] Failed to expire order during sweep');
        }
      }

      logger.info({ expiredCount }, '[EodSweepService] Completed EOD sweep');
    } catch (err) {
      logger.error({ err }, '[EodSweepService] Sweep execution failed');
    }
  }

  public async snapshotPortfolios(now: Date) {
    logger.info('[EodSweepService] Starting EOD portfolio snapshots...');
    const startTime = Date.now();
    const batchSize = 100;
    
    // Normalize date to midnight UTC for standard daily snapshots
    const snapshotDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    let processedCount = 0;
    let failureCount = 0;
    let dbQueryCount = 0;
    let skip = 0;
    let hasMore = true;

    while (hasMore) {
      const portfolios = await this.prisma.portfolio.findMany({
        select: { id: true },
        take: batchSize,
        skip: skip,
        orderBy: { id: 'asc' }
      });
      dbQueryCount++;

      if (portfolios.length === 0) {
        hasMore = false;
        break;
      }

      for (const p of portfolios) {
        try {
          // Idempotency check
          const existing = await this.prisma.portfolioSnapshot.findUnique({
            where: { portfolioId_snapshotDate: { portfolioId: p.id, snapshotDate } }
          });
          dbQueryCount++;

          if (existing) {
            processedCount++;
            continue; // Skip if already captured
          }

          const val = await this.valuationService.getValuation(p.id);
          dbQueryCount += 2; // Valuation does some querying (findUnique + get prices via redis)

          await this.prisma.portfolioSnapshot.create({
            data: {
              portfolioId: p.id,
              snapshotDate: snapshotDate,
              totalCash: val.totalCash,
              marketValue: val.marketValue,
              totalNav: val.totalNav,
              unrealizedPnl: val.unrealizedPnl,
              realizedPnl: val.realizedPnl,
              isStale: val.isStale
            }
          });
          dbQueryCount++;
          processedCount++;
        } catch (error) {
          logger.error({ error, portfolioId: p.id }, '[EodSweepService] Failed to snapshot portfolio');
          failureCount++;
        }
      }

      skip += batchSize;
    }

    const durationMs = Date.now() - startTime;
    logger.info({
      processedCount,
      failureCount,
      dbQueryCount,
      durationMs
    }, '[EodSweepService] EOD portfolio snapshots completed');
  }

  private emitSessionStatus(status: 'OPEN' | 'CLOSED') {
    const envelope: EventEnvelope = {
      eventId: crypto.randomUUID(),
      type: 'SESSION_STATUS',
      timestamp: defaultTimeProvider.now().toISOString(),
      payload: { status }
    };
    
    this.emitter.to('market:global').emit('SESSION_STATUS', envelope);
    logger.info({ status }, '[EodSweepService] Emitted global SESSION_STATUS');
  }
}
