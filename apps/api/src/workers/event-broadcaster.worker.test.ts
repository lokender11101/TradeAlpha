import { EventBroadcasterWorker } from './event-broadcaster.worker';
import { Emitter } from '@socket.io/redis-emitter';
import Redis from 'ioredis';
import { Job } from 'bullmq';

jest.mock('@socket.io/redis-emitter');
jest.mock('ioredis');
jest.mock('bullmq', () => {
  return {
    Worker: jest.fn().mockImplementation((name, processor) => ({
      on: jest.fn(),
      close: jest.fn(),
      processor
    })),
    Job: jest.fn()
  };
});

describe('EventBroadcasterWorker', () => {
  let worker: EventBroadcasterWorker;
  let mockEmit: jest.Mock;
  let mockTo: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockEmit = jest.fn();
    mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
    (Emitter as jest.Mock).mockImplementation(() => ({
      to: mockTo
    }));

    worker = new EventBroadcasterWorker('redis://localhost:6379');
  });

  afterEach(async () => {
    await worker.close();
  });

  it('should broadcast a valid domain event to the correct portfolio room', async () => {
    const processor = (worker as any).worker.processor;
    
    const mockJob = {
      id: 'job-123',
      data: {
        eventId: 'event-123',
        type: 'ORDER_FILLED',
        payload: {
          portfolioId: 'portfolio-abc',
          orderId: 'order-123',
          status: 'FILLED'
        }
      }
    } as unknown as Job;

    await processor(mockJob);

    expect(mockTo).toHaveBeenCalledWith('portfolio:portfolio-abc');
    expect(mockEmit).toHaveBeenCalledWith('ORDER_FILLED', expect.objectContaining({
      eventId: 'event-123',
      type: 'ORDER_FILLED',
      payload: {
        portfolioId: 'portfolio-abc',
        orderId: 'order-123',
        status: 'FILLED'
      }
    }));
  });

  it('should ignore events without portfolioId', async () => {
    const processor = (worker as any).worker.processor;
    
    const mockJob = {
      id: 'job-123',
      data: {
        eventId: 'event-123',
        type: 'SYSTEM_EVENT',
        payload: {
          someOtherData: true
        }
      }
    } as unknown as Job;

    await processor(mockJob);

    expect(mockTo).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('should throw if emitter fails, ensuring BullMQ retries', async () => {
    const processor = (worker as any).worker.processor;
    
    mockEmit.mockImplementation(() => {
      throw new Error('Redis down');
    });

    const mockJob = {
      id: 'job-123',
      data: {
        eventId: 'event-123',
        type: 'ORDER_FILLED',
        payload: {
          portfolioId: 'portfolio-abc'
        }
      }
    } as unknown as Job;

    await expect(processor(mockJob)).rejects.toThrow('Redis down');
  });
});
