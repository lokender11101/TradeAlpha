import { AsyncLocalStorage } from 'async_hooks';
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export interface CorrelationContext {
  requestId: string;
  correlationId: string;
}

export const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

export const correlationMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const requestId = crypto.randomUUID();
  const correlationId = (req.headers['x-correlation-id'] as string) || requestId;

  res.setHeader('x-request-id', requestId);
  res.setHeader('x-correlation-id', correlationId);

  correlationStorage.run({ requestId, correlationId }, () => {
    next();
  });
};

export const getCorrelationId = (): string => {
  const store = correlationStorage.getStore();
  return store?.correlationId || crypto.randomUUID();
};
