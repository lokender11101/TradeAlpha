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
      colorize: true,
      ignore: 'pid,hostname'
    }
  }
});

import { OrderController } from './controllers/order.controller';
import { PortfolioController } from './controllers/portfolio.controller';
import { AuthController } from './controllers/auth.controller';
import { authenticateJWT } from './middlewares/auth.middleware';

import cookieParser from 'cookie-parser';
import { requireCsrfToken } from './middlewares/csrf.middleware';
import { correlationMiddleware } from './middlewares/correlation.middleware';

app.use(correlationMiddleware);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.post('/api/auth/register', AuthController.register);
app.post('/api/auth/login', AuthController.login);
app.post('/api/auth/logout', requireCsrfToken, AuthController.logout);
app.get('/api/auth/session', AuthController.getSession);

app.get('/health', (req: express.Request, res: express.Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

import { MarketController } from './controllers/market.controller';

app.post('/api/orders', requireCsrfToken, authenticateJWT, OrderController.placeOrder);
app.get('/api/orders', authenticateJWT, OrderController.getOrders);
app.get('/api/market/status', MarketController.getStatus);
app.get('/api/market/candles', MarketController.getCandles);
app.get('/api/market/execution-profile', MarketController.getExecutionProfile);
app.delete('/api/orders/:id', requireCsrfToken, authenticateJWT, OrderController.cancelOrder);
// Portfolio Routes
app.get('/api/portfolios/:portfolioId', authenticateJWT, PortfolioController.getPortfolio);
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

if (process.env.NODE_ENV !== 'test') {
  httpServer.listen(port, () => {
    logger.info(`[API] Server running and fully armed on port ${port}`);
  });
}

export { app, httpServer };
