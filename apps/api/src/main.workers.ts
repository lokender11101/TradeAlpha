import { setupTelemetry } from "./telemetry";
setupTelemetry("tradealpha-workers");

import dotenv from 'dotenv';
import pino from 'pino';
import express from 'express';
import { metricsRegistry } from './telemetry';
import { PrismaClient } from '@prisma/client';
import { OutboxWorker } from './workers/outbox.worker';
import { ExecutionWorker } from './workers/execution.worker';
import { DomainEventDispatcherWorker } from './workers/domain-event-dispatcher.worker';
import { OrderService } from './services/order.service';

dotenv.config();
console.log(`[Workers Boot] NODE_ENV=${process.env.NODE_ENV}, MOCK_TIME=${process.env.MOCK_TIME}`);

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

const orderService = new OrderService(prisma);

import { EodSweepService } from './services/eod-sweep.service';
import { OhlcvAggregatorWorker } from './workers/ohlcv-aggregator.worker';

const outboxWorker = new OutboxWorker(prisma, redisUrl);
const executionWorker = new ExecutionWorker(prisma, redisUrl);
const domainEventDispatcher = new DomainEventDispatcherWorker(redisUrl, orderService);
const eodSweepService = new EodSweepService(redisUrl, prisma);
const ohlcvAggregator = new OhlcvAggregatorWorker(prisma, redisUrl);

if (process.env.NODE_ENV !== 'test') {
  logger.info('[Workers] Starting background workers...');

  Promise.all([
    outboxWorker.start(),
    ohlcvAggregator.start(),
  ]).then(() => {
    eodSweepService.start();
    logger.info('[Workers] All background workers started successfully.');
  }).catch(err => {
    logger.error({ err }, 'Failed to start background workers');
    process.exit(1);
  });

  const shutdown = async () => {
    logger.info('Shutting down background workers...');
    eodSweepService.stop();
    await outboxWorker.stop();
    await ohlcvAggregator.stop();
    await executionWorker.close();
    await domainEventDispatcher.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export { outboxWorker, executionWorker, domainEventDispatcher, eodSweepService, ohlcvAggregator };

const metricsApp = express();
metricsApp.get('/metrics', async (req, res) => {
  res.set('Content-Type', metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
});
metricsApp.listen(4002, () => console.log('Metrics on port 4002'));
