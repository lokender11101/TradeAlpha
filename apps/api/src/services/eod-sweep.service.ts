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
  private interval?: NodeJS.Timeout;

  constructor(redisUrl: string, prisma: PrismaClient) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.prisma = prisma;
    this.orderService = new OrderService(this.prisma);
    this.emitter = new Emitter(this.redis);
  }

  public start() {
    // Check every second for the exact transition moment
    this.interval = setInterval(() => this.tick(), 1000);
    logger.info('[EodSweepService] Started EOD sweep watcher');
  }

  public stop() {
    if (this.interval) clearInterval(this.interval);
  }

  private async tick() {
    const now = defaultTimeProvider.now();
    const timeStr = formatInTimeZone(now, 'Asia/Kolkata', 'HH:mm:ss');
    
    // Trigger exactly at 15:30:00
    if (timeStr === '15:30:00') {
      const dateStr = formatInTimeZone(now, 'Asia/Kolkata', 'yyyy-MM-dd');
      const leaseKey = `eod:sweep:global:${dateStr}`;
      
      // Attempt to acquire distributed singleton lease
      const acquired = await this.redis.set(leaseKey, 'locked', 'EX', 60, 'NX');
      
      if (acquired) {
        logger.info('[EodSweepService] Acquired EOD sweep lease. Executing transition...');
        await this.executeSweep();
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
      // Find all orders that are day orders and active
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

  private emitSessionStatus(status: 'OPEN' | 'CLOSED') {
    const envelope: EventEnvelope = {
      eventId: crypto.randomUUID(),
      type: 'SESSION_STATUS',
      timestamp: defaultTimeProvider.now().toISOString(),
      payload: { status }
    };
    
    // Broadcast to a global channel for all connected clients
    this.emitter.to('market:global').emit('SESSION_STATUS', envelope);
    logger.info({ status }, '[EodSweepService] Emitted global SESSION_STATUS');
  }
}
