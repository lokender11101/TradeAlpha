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
  logger.error(err.message);
  res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } });
});

const httpServer = createServer(app);

// Initialize WebSocket Server
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
export const wsServer = new WebSocketServer(httpServer, redisUrl, prisma);

if (process.env.NODE_ENV !== 'test') {
  httpServer.listen(port, () => {
    logger.info(`Server running on port ${port}`);
  });
}

export { app, httpServer };
