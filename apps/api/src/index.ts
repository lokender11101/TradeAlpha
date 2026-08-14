import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pino from 'pino';
import { createServer } from 'http';
import { WebSocketServer } from './websocket';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const prisma = new PrismaClient();

const app = express();
const port = process.env.PORT || 4000;
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  }
});

import { OrderController } from './controllers/order.controller';
import { PortfolioController } from './controllers/portfolio.controller';
import { AuthController } from './controllers/auth.controller';
import { authenticateJWT } from './middlewares/auth.middleware';

app.use(cors());
app.use(express.json());

app.post('/api/auth/register', AuthController.register);
app.post('/api/auth/login', AuthController.login);

app.get('/health', (req: express.Request, res: express.Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/orders', authenticateJWT, OrderController.placeOrder);
app.get('/api/portfolios/:portfolioId/positions', authenticateJWT, PortfolioController.getPositions);

app.use((req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
});

app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error in API:', err);
  logger.error({ err }, err.message);
  res.status(500).json({ error: 'Internal Server Error' });
});

const httpServer = createServer(app);

// Initialize WebSocket Server
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
export const wsServer = new WebSocketServer(httpServer, redisUrl, prisma);

import { TradingEngine } from './engine/trading-engine';
import { MarketSimulatorService } from './services/market-simulator.service';
import { OrderService } from './services/order.service';
import { OutboxWorker } from './workers/outbox.worker';
import { ExecutionWorker } from './workers/execution.worker';
import { DomainEventDispatcherWorker } from './workers/domain-event-dispatcher.worker';

// Worker orchestration instances
export let simulator: MarketSimulatorService;
export let tradingEngine: TradingEngine;
export let outboxWorker: OutboxWorker;
export let executionWorker: ExecutionWorker;
export let domainEventDispatcher: DomainEventDispatcherWorker;

export async function bootstrap() {
  logger.info('Starting Phase 2.9 Unified Bootstrap Sequence...');

  // 1. PostgreSQL/Redis (already initialized)
  const orderService = new OrderService(prisma);

  // 2. Instantiate TradingEngine
  simulator = new MarketSimulatorService();
  tradingEngine = new TradingEngine(redisUrl, simulator, prisma, orderService);
  logger.info('[Boot] TradingEngine instantiated');

  // 3. Hydration
  await tradingEngine.hydrate();

  // 4. Reconciliation
  tradingEngine.startReconciliation(30000); // 30s interval

  // 5. Instantiating and starting background workers
  // Start Outbox Worker to sweep events to BullMQ
  outboxWorker = new OutboxWorker(prisma, redisUrl);
  await outboxWorker.start();
  logger.info('[Boot] OutboxWorker started');

  // Start Domain Event Dispatcher (routing ORDER_ACCEPTED and broadcasting)
  domainEventDispatcher = new DomainEventDispatcherWorker(redisUrl, tradingEngine, orderService);
  logger.info('[Boot] DomainEventDispatcherWorker started');

  // Start Execution Worker (process EXECUTE_FILL)
  executionWorker = new ExecutionWorker(prisma, redisUrl);
  logger.info('[Boot] ExecutionWorker started');

  // 6. Market Simulator
  // Start a default simulation for AAPL so the engine has something to chew on
  simulator.startSimulation({ symbol: 'AAPL', initialPrice: 150.0, volatility: 0.005, intervalMs: 2000 });
  logger.info('[Boot] MarketSimulatorService started for AAPL');

  // 7. HTTP/WebSocket readiness
  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => {
      logger.info(`Server running and fully armed on port ${port}`);
      resolve();
    });
  });
}

if (process.env.NODE_ENV !== 'test') {
  bootstrap().catch(err => {
    logger.error({ err }, 'Failed to bootstrap TradeAlpha');
    process.exit(1);
  });
}

export { app, httpServer };
