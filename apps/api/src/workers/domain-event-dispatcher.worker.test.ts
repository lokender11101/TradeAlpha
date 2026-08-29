import { DomainEventDispatcherWorker } from './domain-event-dispatcher.worker';
import { Job } from 'bullmq';

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_name, _processor, _opts) => ({
    on: jest.fn(),
    close: jest.fn()
  })),
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({}),
    close: jest.fn()
  }))
}));

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    quit: jest.fn()
  }));
});

const mockEmit = jest.fn();
jest.mock('@socket.io/redis-emitter', () => {
  return {
    Emitter: jest.fn().mockImplementation(() => ({
      to: jest.fn().mockReturnValue({ emit: mockEmit })
    }))
  };
});

describe('DomainEventDispatcherWorker', () => {
  let worker: DomainEventDispatcherWorker;
  let mockOrderService: any;
  let mockRedis: any;

  beforeEach(() => {
    mockEmit.mockClear();

    mockOrderService = {
      markOrderPending: jest.fn().mockResolvedValue({ id: 'order-1', symbol: 'AAPL' })
    };

    worker = new DomainEventDispatcherWorker('redis://localhost:6379', mockOrderService);
    mockRedis = (worker as any).redis;
    mockRedis.publish = jest.fn();
  });

  afterEach(async () => {
    await worker.close();
  });

  it('should process ORDER_ACCEPTED by routing to PENDING and Redis, then broadcasting', async () => {
    const job = {
      id: 'job-1',
      data: {
        eventId: 'event-1',
        type: 'ORDER_ACCEPTED',
        payload: {
          portfolioId: 'portfolio-1',
          orderId: 'order-1'
        }
      }
    } as unknown as Job;

    await (worker as any).processJob(job);

    expect(mockOrderService.markOrderPending).toHaveBeenCalledWith('order-1');
    expect(mockRedis.publish).toHaveBeenCalledWith('engine:route:AAPL', expect.stringContaining('"orderId":"order-1"'));
    expect(mockRedis.publish).toHaveBeenCalledWith('engine:route:AAPL', expect.stringContaining('"symbol":"AAPL"'));
    expect(mockEmit).toHaveBeenCalledWith('ORDER_ACCEPTED', expect.objectContaining({ eventId: 'event-1' }));
  });

  it('should cleanly handle idempotent duplicate ORDER_ACCEPTED events', async () => {
    const job = {
      id: 'job-1',
      data: {
        eventId: 'event-1',
        type: 'ORDER_ACCEPTED',
        payload: {
          portfolioId: 'portfolio-1',
          orderId: 'order-1'
        }
      }
    } as unknown as Job;

    mockOrderService.markOrderPending.mockRejectedValue(new Error('Invalid state transition from PENDING to PENDING'));

    await (worker as any).processJob(job);

    // It should silently catch the idempotent error and proceed to broadcast
    expect(mockOrderService.markOrderPending).toHaveBeenCalledWith('order-1');
    expect(mockEmit).toHaveBeenCalledWith('ORDER_ACCEPTED', expect.objectContaining({ eventId: 'event-1' }));
  });

  it('should process terminal events by publishing route to Redis and broadcasting', async () => {
    const terminalTypes = ['ORDER_FILLED', 'ORDER_REJECTED', 'ORDER_CANCELLED', 'ORDER_EXPIRED'];

    for (const type of terminalTypes) {
      mockEmit.mockClear();
      mockRedis.publish.mockClear();

      const job = {
        id: `job-${type}`,
        data: {
          eventId: `event-${type}`,
          type,
          payload: {
            portfolioId: 'portfolio-1',
            orderId: 'order-1',
            symbol: 'AAPL'
          }
        }
      } as unknown as Job;

      await (worker as any).processJob(job);

      expect(mockRedis.publish).toHaveBeenCalledWith('engine:route:AAPL', expect.stringContaining('"orderId":"order-1"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('engine:route:AAPL', expect.stringContaining('"symbol":"AAPL"'));
      expect(mockEmit).toHaveBeenCalledWith(type, expect.objectContaining({ eventId: `event-${type}` }));
    }
  });
});
