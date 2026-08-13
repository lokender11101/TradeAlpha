import { createServer, Server as HttpServer } from 'http';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import { WebSocketServer, MAX_MARKET_SUBSCRIPTIONS_PER_SOCKET } from './websocket';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

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
      
      // Connect client with valid auth
      clientSocket = Client(`http://localhost:${port}`, {
        auth: { userId: 'user-123' }
      });
      
      io.io.on('connection', (socket) => {
        serverSocket = socket;
      });
      
      clientSocket.on('connect', done);
    });
  });

  afterAll((done) => {
    io.close();
    clientSocket.disconnect();
    httpServer.close(done);
  });

  it('should reject connection without userId', (done) => {
    const port = (httpServer.address() as any).port;
    const badClient = Client(`http://localhost:${port}`, { auth: {} });
    
    badClient.on('connect_error', (err) => {
      expect(err.message).toMatch(/Authentication Error/);
      badClient.disconnect();
      done();
    });
  });

  it('should accept valid portfolio join', (done) => {
    (prisma.portfolio.findUnique as jest.Mock).mockResolvedValue({ id: 'port-123', userId: 'user-123' });
    
    clientSocket.emit('join_portfolio', 'port-123', (res: any) => {
      expect(res.success).toBe(true);
      expect(serverSocket.rooms.has('portfolio:port-123')).toBe(true);
      done();
    });
  });

  it('should reject unauthorized portfolio join', (done) => {
    (prisma.portfolio.findUnique as jest.Mock).mockResolvedValue({ id: 'port-456', userId: 'other-user' });
    
    clientSocket.emit('join_portfolio', 'port-456', (res: any) => {
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Unauthorized/);
      expect(serverSocket.rooms.has('portfolio:port-456')).toBe(false);
      done();
    });
  });

  it('should allow joining market rooms up to limit', (done) => {
    clientSocket.emit('join_market', 'AAPL', (res: any) => {
      expect(res.success).toBe(true);
      expect(serverSocket.rooms.has('market:AAPL')).toBe(true);
      done();
    });
  });

  it('should prevent joining duplicate market rooms', (done) => {
    clientSocket.emit('join_market', 'AAPL', (res: any) => {
      expect(res.success).toBe(true);
      expect(serverSocket.data.marketSubscriptions.size).toBe(1); // Still 1
      done();
    });
  });
});
