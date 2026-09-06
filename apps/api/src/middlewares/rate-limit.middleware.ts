import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import Redis from 'ioredis';
import { Request } from 'express';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redisClient = new Redis(redisUrl, { maxRetriesPerRequest: null });

// Helper to generate key using IP for unauthenticated users, or JWT sub (userId) for authenticated users
const keyGenerator = (req: Request): string => {
  if ((req as any).user && (req as any).user.id) {
    return (req as any).user.id;
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
};

// A. Authentication Rate Limiter
export const authRateLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args: string[]) => (redisClient as any).call(...args),
    prefix: 'rl:auth:'
  }),
  windowMs: 5 * 60 * 1000, 
  max: process.env.NODE_ENV === 'test' ? 1000 : 15, // Allow more for E2E tests
  message: { error: 'Too many authentication attempts, please try again later.' },
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || 'unknown'
});

// B. Order Submission Rate Limiter
export const orderRateLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args: string[]) => (redisClient as any).call(...args),
    prefix: 'rl:order:'
  }),
  windowMs: 60 * 1000, 
  max: process.env.NODE_ENV === 'test' ? 10000 : 100, // High burst allowance
  message: { error: 'Order submission rate limit exceeded.' },
  keyGenerator
});

// C. Portfolio Reads Rate Limiter
export const portfolioRateLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args: string[]) => (redisClient as any).call(...args),
    prefix: 'rl:portfolio:'
  }),
  windowMs: 60 * 1000, 
  max: process.env.NODE_ENV === 'test' ? 500 : 120,
  message: { error: 'Portfolio read rate limit exceeded.' },
  keyGenerator
});

// D. Market Data Reads Rate Limiter
export const marketRateLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args: string[]) => (redisClient as any).call(...args),
    prefix: 'rl:market:'
  }),
  windowMs: 60 * 1000, 
  max: process.env.NODE_ENV === 'test' ? 1000 : 300,
  message: { error: 'Market data rate limit exceeded.' },
  keyGenerator
});
