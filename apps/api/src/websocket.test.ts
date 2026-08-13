import { createServer, Server as HttpServer } from 'http';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import { WebSocketServer, MAX_MARKET_SUBSCRIPTIONS_PER_SOCKET } from './websocket';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    duplicate: jest.fn().mockReturnThis(),
    quit: jest.fn().mockResolvedValue(true),
    on: jest.fn(),
    subscribe: jest.fn(),
    publish: jest.fn(),
    psubscribe: jest.fn()
  }));
});

describe('WebSocketServer', () => {
  let io: WebSocketServer;
  let serverSocket: any;
  let clientSocket: ClientSocket;
  let httpServer: HttpServer;
  let prisma: PrismaClient;

  beforeAll((done) => {
    httpServer = createServer();
    prisma = {
      portfolio: {
        findUnique: jest.fn()
      }
    } as unknown as PrismaClient;
    
    io = new WebSocketServer(httpServer, 'redis://localhost', prisma);
    
    httpServer.listen(() => {
      const port = (httpServer.address() as any).port;
      
      const validToken = jwt.sign({}, 'fallback-secret-for-tests', { subject: 'user-123' });
      
      // Connect client with valid auth
      clientSocket = Client(`http://localhost:${port}`, {
        auth: { token: validToken }
      });
      
      io.io.on('connection', (socket) => {
        if (!serverSocket) {
          serverSocket = socket;
        }
      });
      
      clientSocket.on('connect', done);
    });
  });

  afterAll((done) => {
    io.close();
    clientSocket.disconnect();
    httpServer.close(done);
  });

  it('should reject connection without token', (done) => {
    const port = (httpServer.address() as any).port;
    const badClient = Client(`http://localhost:${port}`, { auth: {} });
    
    badClient.on('connect_error', (err) => {
      expect(err.message).toMatch(/Authentication Error: Missing token/);
      badClient.disconnect();
      done();
    });
  });

  it('should reject connection with invalid token', (done) => {
    const port = (httpServer.address() as any).port;
    const badClient = Client(`http://localhost:${port}`, { auth: { token: 'invalid.token.here' } });
    
    badClient.on('connect_error', (err) => {
      expect(err.message).toMatch(/Authentication Error: Invalid or expired token/);
      badClient.disconnect();
      done();
    });
  });

  it('should prevent changing identity by manipulating raw userId payload (Impersonation check)', (done) => {
    // Attack scenario: Attacker has a valid token for user-123 but tries to force userId to 'victim-id'
    const validTokenUserA = jwt.sign({}, 'fallback-secret-for-tests', { subject: 'user-123' });
    const port = (httpServer.address() as any).port;
    const attackerClient = Client(`http://localhost:${port}`, { 
      auth: { token: validTokenUserA, userId: 'victim-id' } 
    });
    
    attackerClient.on('connect', () => {
      // Make sure we resolve the mock correctly for this specific portfolio query
      (prisma.portfolio.findUnique as jest.Mock).mockImplementation(async (args) => {
        if (args.where.id === 'port-victim') {
          return { id: 'port-victim', userId: 'victim-id' };
        }
        return null;
      });
      
      attackerClient.emit('join_portfolio', 'port-victim', (res: any) => {
        try {
          expect(res.success).toBe(false);
          expect(res.error).toMatch(/Unauthorized: Cannot subscribe to another user's portfolio/); // We changed the error message
          attackerClient.disconnect();
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('should accept valid portfolio join', (done) => {
    (prisma.portfolio.findUnique as jest.Mock).mockImplementation(async (args) => {
      if (args.where.id === 'port-123') return { id: 'port-123', userId: 'user-123' };
      return null;
    });
    
    clientSocket.emit('join_portfolio', 'port-123', (res: any) => {
      try {
        expect(res.success).toBe(true);
        expect(serverSocket.rooms.has('portfolio:port-123')).toBe(true);
        done();
      } catch (e) {
        done(e);
      }
    });
  });

  it('should reject unauthorized portfolio join', (done) => {
    (prisma.portfolio.findUnique as jest.Mock).mockImplementation(async (args) => {
      if (args.where.id === 'port-456') return { id: 'port-456', userId: 'other-user' };
      return null;
    });
    
    clientSocket.emit('join_portfolio', 'port-456', (res: any) => {
      try {
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/Unauthorized: Cannot subscribe to another user's portfolio/);
        expect(serverSocket.rooms.has('portfolio:port-456')).toBe(false);
        done();
      } catch (e) {
        done(e);
      }
    });
  });

  it('should allow joining market rooms up to limit', (done) => {
    clientSocket.emit('join_market', 'AAPL', (res: any) => {
      try {
        expect(res.success).toBe(true);
        expect(serverSocket.rooms.has('market:AAPL')).toBe(true);
        done();
      } catch (e) {
        done(e);
      }
    });
  });

  it('should prevent joining duplicate market rooms', (done) => {
    clientSocket.emit('join_market', 'AAPL', (res: any) => {
      try {
        expect(res.success).toBe(true);
        expect(serverSocket.data.marketSubscriptions.size).toBe(1); // Still 1
        done();
      } catch (e) {
        done(e);
      }
    });
  });
});
