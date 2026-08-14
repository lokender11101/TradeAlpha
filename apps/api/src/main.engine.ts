import dotenv from 'dotenv';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { TradingEngine } from './engine/trading-engine';
import { OrderService } from './services/order.service';
import { PriceCacheService } from './services/price-cache.service';
import Redis from 'ioredis';

dotenv.config();

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname'
    }
  }
});

const prisma = new PrismaClient();
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const ioredisClient = new Redis(redisUrl, { maxRetriesPerRequest: null });

const orderService = new OrderService(prisma);
const priceCacheService = new PriceCacheService(ioredisClient);

const assignedSymbols = process.env.SYMBOLS_HANDLED 
  ? process.env.SYMBOLS_HANDLED.split(',') 
  : ['AAPL', 'MSFT', 'TSLA', 'GOOGL', 'AMZN'];

const tradingEngine = new TradingEngine(redisUrl, prisma, orderService, priceCacheService, assignedSymbols);

if (process.env.NODE_ENV !== 'test') {
  logger.info({ assignedSymbols }, '[Engine] Starting Trading Engine...');
  
  tradingEngine.start().then(() => {
    logger.info('[Engine] Trading Engine fully started and subscribed.');
  }).catch(err => {
    logger.error({ err }, 'Failed to start Trading Engine');
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    logger.info('Shutting down Trading Engine...');
    await tradingEngine.close();
    await prisma.$disconnect();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    logger.info('Shutting down Trading Engine...');
    await tradingEngine.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

export { tradingEngine };
