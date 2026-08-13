import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();

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

app.use(cors());
app.use(express.json());

app.get('/health', (req: express.Request, res: express.Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/orders', OrderController.placeOrder);

app.use((req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
});

app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(err.message);
  res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    logger.info(`Server running on port ${port}`);
  });
}

export { app };
