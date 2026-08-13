import { PrismaClient, EventStatus } from '@prisma/client';
import { OutboxWorker } from './outbox.worker';

// Mock bullmq Queue so we don't need a real Redis for the worker publish logic
// We test the concurrency of the polling mechanism via PostgreSQL
jest.mock('bullmq', () => {
  return {
    Queue: jest.fn().mockImplementation(() => ({
      add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
      close: jest.fn().mockResolvedValue(true)
    }))
  };
});

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    quit: jest.fn().mockResolvedValue(true)
  }));
});

const prisma = new PrismaClient();
const REDIS_URL = 'redis://localhost:6379';

describe('Transactional Outbox Worker (Phase 2.4)', () => {
  let worker1: OutboxWorker;
  let worker2: OutboxWorker;

  beforeAll(async () => {
    worker1 = new OutboxWorker(prisma, REDIS_URL);
    worker2 = new OutboxWorker(prisma, REDIS_URL);
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({});
    await worker1.stop();
    await worker2.stop();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Only clear outbox events to avoid wiping other test tables. We'll use --runInBand to prevent file-level concurrency.
    await prisma.outboxEvent.deleteMany({});
    jest.clearAllMocks();
    
    // Re-instantiate workers so the mock queue adds are captured correctly after clearAllMocks
    worker1 = new OutboxWorker(prisma, REDIS_URL);
    worker2 = new OutboxWorker(prisma, REDIS_URL);
  });

  it('should process pending events and mark them PUBLISHED', async () => {
    // Insert a pending event
    const event = await prisma.outboxEvent.create({
      data: {
        type: 'ORDER_ACCEPTED',
        aggregateType: 'Order',
        aggregateId: 'order-123',
        payload: { orderId: 'order-123' },
        status: EventStatus.PENDING
      }
    });

    const count = await worker1.processOutbox();
    expect(count).toBe(1);

    const updated = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
    expect(updated?.status).toBe(EventStatus.PUBLISHED);
    expect(updated?.publishedAt).not.toBeNull();
  });

  it('should ignore events that are already PUBLISHED', async () => {
    await prisma.outboxEvent.create({
      data: {
        type: 'ORDER_ACCEPTED',
        aggregateType: 'Order',
        aggregateId: 'order-123',
        payload: { orderId: 'order-123' },
        status: EventStatus.PUBLISHED,
        publishedAt: new Date()
      }
    });

    const count = await worker1.processOutbox();
    expect(count).toBe(0);
  });

  it('should process events safely with multiple concurrent workers (SKIP LOCKED)', async () => {
    // Insert 10 pending events
    await prisma.outboxEvent.createMany({
      data: Array.from({ length: 10 }).map((_, i) => ({
        type: 'ORDER_ACCEPTED',
        aggregateType: 'Order',
        aggregateId: `order-${i}`,
        payload: { orderId: `order-${i}` },
        status: EventStatus.PENDING
      }))
    });

    // Both workers poll at the EXACT same time
    const [w1Count, w2Count] = await Promise.all([
      worker1.processOutbox(),
      worker2.processOutbox()
    ]);

    // Because we use BATCH_SIZE=50, the first worker to acquire the lock might grab all 10
    // OR they might grab a mix. Regardless, exactly 10 should be processed.
    expect(w1Count + w2Count).toBe(10);

    const pending = await prisma.outboxEvent.count({ where: { status: EventStatus.PENDING } });
    expect(pending).toBe(0);
    const published = await prisma.outboxEvent.count({ where: { status: EventStatus.PUBLISHED } });
    expect(published).toBe(10);
  });

  it('should correctly increment attempts and schedule retry on publish failure', async () => {
    worker1['queue'].add = jest.fn().mockRejectedValueOnce(new Error('Redis timeout'));

    const event = await prisma.outboxEvent.create({
      data: {
        type: 'ORDER_CANCELLED',
        aggregateType: 'Order',
        aggregateId: 'order-999',
        payload: { orderId: 'order-999' },
        status: EventStatus.PENDING
      }
    });

    await worker1.processOutbox();

    const failed = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
    expect(failed?.status).toBe(EventStatus.FAILED);
    expect(failed?.attempts).toBe(1);
    expect(failed?.nextRetryAt).not.toBeNull();
    expect(failed?.error).toBe('Redis timeout');

    // Make sure it doesn't process it immediately (nextRetryAt is in the future)
    const count = await worker1.processOutbox();
    expect(count).toBe(0);
  });

  it('should permanently fail event after MAX_RETRIES', async () => {
    worker1['queue'].add = jest.fn().mockRejectedValue(new Error('Fatal Redis Error'));

    const event = await prisma.outboxEvent.create({
      data: {
        type: 'ORDER_REJECTED',
        aggregateType: 'Order',
        aggregateId: 'order-fail',
        payload: { orderId: 'order-fail' },
        status: EventStatus.FAILED,
        attempts: 4, // Next failure will be 5 (MAX_RETRIES)
        nextRetryAt: new Date(Date.now() - 10000) // Retry is overdue
      }
    });

    await worker1.processOutbox();

    const failed = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
    expect(failed?.status).toBe(EventStatus.FAILED);
    expect(failed?.attempts).toBe(5);
    expect(failed?.nextRetryAt).toBeNull(); // Permanently failed
  });

  it('should handle worker crash after publish but before marking PUBLISHED (Crash scenario A & B)', async () => {
    // We simulate a crash by intercepting the prisma.$executeRaw used to mark PUBLISHED
    // so it throws an error after the queue.add succeeds.
    const originalExecuteRaw = prisma.$executeRaw;
    prisma.$executeRaw = jest.fn().mockRejectedValueOnce(new Error('Simulated DB Crash'));

    const event = await prisma.outboxEvent.create({
      data: {
        type: 'ORDER_ACCEPTED',
        aggregateType: 'Order',
        aggregateId: 'crash-order',
        payload: { orderId: 'crash-order' },
        status: EventStatus.PENDING
      }
    });

    // Worker 1 runs and "crashes" during DB ack
    await worker1.processOutbox();

    // A real crash means the worker process dies immediately.
    // In our implementation, the single-query Lease Pattern (`UPDATE ... RETURNING`) already
    // set next_retry_at = +1 minute while leaving status as PENDING.
    // Since we mocked $executeRaw to throw, the catch block runs, but because it's a mock
    // without a fallback, it doesn't write to the DB. This perfectly simulates a process crash
    // where no subsequent DB writes occur.
    
    const crashedEvent = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
    expect(crashedEvent?.status).toBe(EventStatus.PENDING); // Status remains PENDING
    expect(crashedEvent?.nextRetryAt).not.toBeNull(); // But a lease is held!

    // Restore prisma execute
    prisma.$executeRaw = originalExecuteRaw;

    // For test, we force nextRetryAt to past
    await prisma.$executeRaw`UPDATE outbox_events SET next_retry_at = NOW() - INTERVAL '1 minute' WHERE id = ${event.id}`;

    await worker2.processOutbox();

    // Event should finally be PUBLISHED
    const finalEvent = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
    expect(finalEvent?.status).toBe(EventStatus.PUBLISHED);
    expect(finalEvent?.publishedAt).not.toBeNull();
  });
});
