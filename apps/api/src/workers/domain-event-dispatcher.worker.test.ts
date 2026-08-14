import { DomainEventDispatcherWorker } from './domain-event-dispatcher.worker';
import { Job } from 'bullmq';

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_name, _processor, _opts) => ({
    on: jest.fn(),
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
  let mockEngine: any;
  let mockOrderService: any;

  beforeEach(() => {
    mockEmit.mockClear();
    
    mockEngine = {
      addOrder: jest.fn(),
      removeOrder: jest.fn()
    };

    mockOrderService = {
      markOrderPending: jest.fn().mockResolvedValue({ id: 'order-1', symbol: 'AAPL' })
    };

    worker = new DomainEventDispatcherWorker('redis://localhost:6379', mockEngine, mockOrderService);
  });

  afterEach(async () => {
    await worker.close();
  });

  it('should process ORDER_ACCEPTED by routing to PENDING and Engine, then broadcasting', async () => {
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
    expect(mockEngine.addOrder).toHaveBeenCalledWith(expect.objectContaining({ id: 'order-1' }));
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

  it('should process terminal events by removing from Engine and broadcasting', async () => {
    const terminalTypes = ['ORDER_FILLED', 'ORDER_REJECTED', 'ORDER_CANCELLED', 'ORDER_EXPIRED'];

    for (const type of terminalTypes) {
      mockEmit.mockClear();
      mockEngine.removeOrder.mockClear();

      const job = {
        id: `job-${type}`,
        data: {
          eventId: `event-${type}`,
          type,
          payload: {
            portfolioId: 'portfolio-1',
            orderId: 'order-1'
          }
        }
      } as unknown as Job;

      await (worker as any).processJob(job);

      expect(mockEngine.removeOrder).toHaveBeenCalledWith('order-1');
      expect(mockEmit).toHaveBeenCalledWith(type, expect.objectContaining({ eventId: `event-${type}` }));
    }
  });
});
