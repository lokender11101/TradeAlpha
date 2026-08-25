import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import jwt from 'jsonwebtoken';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, ignore: 'pid,hostname' }
  }
});

export const MAX_MARKET_SUBSCRIPTIONS_PER_SOCKET = 50;

export interface EventEnvelope {
  eventId: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export class WebSocketServer {
  public readonly io: Server;
  private readonly pubClient: Redis;
  private readonly subClient: Redis;
  private readonly prisma: PrismaClient;

  constructor(httpServer: HttpServer, redisUrl: string, prisma: PrismaClient) {
    this.prisma = prisma;
    
    // Create Redis clients for the adapter
    this.pubClient = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.subClient = this.pubClient.duplicate();

    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.FRONTEND_URL || 'http://localhost:3000',
        credentials: true
      },
      adapter: createAdapter(this.pubClient, this.subClient),
      pingTimeout: 5000,
      pingInterval: 10000,
    });

    this.setupAuthentication();
    this.setupEventHandlers();
    this.setupRedisBridging();
  }

  private setupRedisBridging() {
    // The subClient is already used by Socket.io adapter, so we use a separate one for psubscribe
    const bridgeSubClient = this.pubClient.duplicate();
    bridgeSubClient.psubscribe('market:tick:*', 'market:candle:*', (err, count) => {
      if (err) {
        logger.error({ err }, 'Failed to psubscribe to market events');
      } else {
        logger.info(`Bridging WebSocket to Redis PubSub. Subscribed to ${count} patterns.`);
      }
    });

    bridgeSubClient.on('pmessage', (pattern, channel, message) => {
      if (pattern === 'market:tick:*') {
        try {
          const payload = JSON.parse(message);
          if (payload.symbol) {
            this.io.emit('market:tick', payload);
          }
        } catch (e) {
          logger.warn({ err: e }, 'Failed to parse market tick payload');
        }
      } else if (pattern === 'market:candle:*') {
        try {
          const payload = JSON.parse(message);
          if (payload.payload?.symbol) {
            this.io.emit('MARKET_CANDLE', payload);
          }
        } catch (e) {
          logger.warn({ err: e }, 'Failed to parse market candle payload');
        }
      }
    });
  }

  private setupAuthentication() {
    this.io.use((socket, next) => {
      // First check auth payload for backward compatibility (e.g. tests)
      let token = socket.handshake.auth?.token;
      
      // If not present, try to extract from cookies (for browser clients with HttpOnly cookie)
      if (!token && socket.request.headers.cookie) {
        const cookies = socket.request.headers.cookie.split(';').map(c => c.trim());
        const tokenCookie = cookies.find(c => c.startsWith('token='));
        if (tokenCookie) {
          token = tokenCookie.split('=')[1];
        }
      }
      
      if (!token || typeof token !== 'string') {
        logger.warn({ socketId: socket.id, cookies: socket.request.headers.cookie }, 'WebSocket connection rejected: Missing token');
        return next(new Error('Authentication Error: Missing token'));
      }

      const secret = process.env.JWT_SECRET || 'fallback-secret-for-tests';

      jwt.verify(token, secret, (err: any, decoded: any) => {
        if (err) {
          logger.warn({ err }, 'WebSocket JWT Verification Failed');
          return next(new Error('Authentication Error: Invalid or expired token'));
        }

        socket.data.userId = decoded.sub as string;
        socket.data.marketSubscriptions = new Set<string>();
        next();
      });
    });
  }

  private setupEventHandlers() {
    this.io.on('connection', (socket: Socket) => {
      logger.info({ socketId: socket.id, userId: socket.data.userId }, 'WebSocket client connected');

      socket.on('join_portfolio', async (portfolioId: string, callback: (response: { success: boolean; error?: string }) => void) => {
        try {
          if (!portfolioId || typeof portfolioId !== 'string') {
            callback?.({ success: false, error: 'Invalid portfolioId' });
            return;
          }

          const portfolio = await this.prisma.portfolio.findUnique({
            where: { id: portfolioId }
          });

          if (!portfolio) {
            callback?.({ success: false, error: 'Portfolio not found' });
            return;
          }

          if (portfolio.userId !== socket.data.userId) {
            callback?.({ success: false, error: 'Unauthorized: Cannot subscribe to another user\'s portfolio' });
            return;
          }

          const room = `portfolio:${portfolioId}`;
          await socket.join(room);
          logger.info({ socketId: socket.id, portfolioId }, 'Client joined portfolio room');
          callback?.({ success: true });
        } catch (error) {
          logger.error({ err: error, socketId: socket.id }, 'Error in join_portfolio');
          callback?.({ success: false, error: 'Internal Server Error' });
        }
      });

      socket.on('join_market', async (symbol: string, callback: (response: { success: boolean; error?: string }) => void) => {
        try {
          if (!symbol || typeof symbol !== 'string') {
            callback?.({ success: false, error: 'Invalid symbol' });
            return;
          }

          const subscriptions: Set<string> = socket.data.marketSubscriptions;
          if (subscriptions.has(symbol)) {
            callback?.({ success: true }); // Already subscribed
            return;
          }

          if (subscriptions.size >= MAX_MARKET_SUBSCRIPTIONS_PER_SOCKET) {
            callback?.({ success: false, error: `Maximum market subscriptions (${MAX_MARKET_SUBSCRIPTIONS_PER_SOCKET}) reached` });
            return;
          }

          const room = `market:${symbol}`;
          await socket.join(room);
          subscriptions.add(symbol);
          logger.info({ socketId: socket.id, symbol }, 'Client joined market room');
          callback?.({ success: true });
        } catch (error) {
          logger.error({ err: error, socketId: socket.id }, 'Error in join_market');
          callback?.({ success: false, error: 'Internal Server Error' });
        }
      });

      socket.on('leave_market', async (symbol: string, callback: (response: { success: boolean; error?: string }) => void) => {
        try {
          const room = `market:${symbol}`;
          await socket.leave(room);
          socket.data.marketSubscriptions.delete(symbol);
          callback?.({ success: true });
        } catch (_error) {
          callback?.({ success: false, error: 'Internal Server Error' });
        }
      });

      socket.on('disconnect', () => {
        logger.info({ socketId: socket.id, userId: socket.data.userId }, 'WebSocket client disconnected');
        // socket.io automatically leaves all rooms on disconnect
      });
    });
  }

  public async close() {
    this.io.close();
    await this.pubClient.quit();
    await this.subClient.quit();
  }
}
