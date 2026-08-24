import { Worker, Job } from 'bullmq';
import { Emitter } from '@socket.io/redis-emitter';
import Redis from 'ioredis';
import pino from 'pino';
import { EventEnvelope } from '../websocket';
import { OrderService } from '../services/order.service';
import { runInTrace } from '../utils/telemetry-utils';
import { SpanKind, propagation, context, trace } from '@opentelemetry/api';
const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, ignore: 'pid,hostname' }
  }
});

export class DomainEventDispatcherWorker {
  private readonly worker: Worker;
  private readonly redis: Redis;
  private readonly emitter: Emitter;
  private readonly orderService: OrderService;

  constructor(
    redisUrl: string,
    orderService: OrderService,
    queueName: string = 'tradealpha-domain-events'
  ) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.emitter = new Emitter(this.redis);
    this.orderService = orderService;

    this.worker = new Worker(queueName, async (job: Job) => {
      await this.processJob(job);
    }, { connection: this.redis, concurrency: 5 });

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      logger.error({ err, jobId: job?.id }, 'DomainEventDispatcherWorker job failed');
    });

    this.worker.on('error', err => {
      logger.error({ err }, 'DomainEventDispatcherWorker error');
    });
  }

  private async processJob(job: Job): Promise<void> {
    const { eventId, type, payload } = job.data;
    
    // Safety check for envelope format
    if (!eventId || !type || !payload || typeof payload !== 'object') {
      logger.warn({ jobId: job.id }, 'Invalid event format, skipping broadcast');
      return;
    }

    const typedPayload = payload as Record<string, unknown>;
    const parentMetadata = (typedPayload.metadata as Record<string, string>) || {};

    return runInTrace('DomainDispatcher processJob', parentMetadata, SpanKind.CONSUMER, async () => {
      const correlationId = typedPayload.correlationId as string || 'system';
      const businessPayload = typedPayload.payload as Record<string, unknown> || typedPayload;
      
      const orderId = businessPayload.orderId as string | undefined;

      const injectedMetadata: Record<string, string> = {};
      propagation.inject(context.active(), injectedMetadata);

      // 1. Specific routing logic
      if (type === 'ORDER_ACCEPTED' && orderId) {
        try {
          const order = await this.orderService.markOrderPending(orderId);
          await this.redis.publish(`engine:route:${order.symbol}`, JSON.stringify({ orderId: order.id, symbol: order.symbol, correlationId, metadata: injectedMetadata }));
          logger.info({ orderId, symbol: order.symbol, correlationId }, '[Dispatcher] Routed ORDER_ACCEPTED to PENDING and published engine route');
        } catch (err: unknown) {
          if (err instanceof Error && err.message.includes('Invalid state transition')) {
            // Idempotent recovery: already pending or further along.
            logger.info({ orderId }, '[Dispatcher] Order already processed past ACCEPTED. Silently ignoring duplicate routing.');
          } else {
            throw err;
          }
        }
      } else if (['ORDER_PARTIALLY_FILLED', 'ORDER_FILLED', 'ORDER_REJECTED', 'ORDER_CANCELLED', 'ORDER_EXPIRED'].includes(type) && orderId) {
        const symbol = businessPayload.symbol as string | undefined;
        if (symbol) {
          logger.info({ orderId, symbol, correlationId }, `[Dispatcher] Routed ${type} and published engine route`);
          await this.redis.publish(`engine:route:${symbol}`, JSON.stringify({ orderId, symbol, correlationId, metadata: injectedMetadata }));
        }
      }

      // 2. Broadcast to WebSockets
      const portfolioId = businessPayload.portfolioId as string;
      
      if (portfolioId) {
        const envelope: EventEnvelope = {
          eventId,
          type,
          timestamp: new Date().toISOString(),
          payload: businessPayload
        };

        try {
          const tracer = trace.getTracer('tradealpha');
          await tracer.startActiveSpan(`Socket.IO Emit ${type}`, { kind: SpanKind.PRODUCER }, async (emitSpan) => {
            try {
              emitSpan.setAttribute('socket.room', `portfolio:${portfolioId}`);
              emitSpan.setAttribute('event.type', type);
              this.emitter.to(`portfolio:${portfolioId}`).emit(type, envelope);
              logger.info({ eventId, type, portfolioId }, 'Broadcasted domain event to WebSocket room');
            } catch (err: any) {
              emitSpan.recordException(err);
              throw err;
            } finally {
              emitSpan.end();
            }
          });
        } catch (error: any) {
          logger.error({ err: error, eventId }, 'Failed to emit WebSocket event');
          throw error;
        }
      }
    });
  }

  public async close(): Promise<void> {
    await this.worker.close();
    await this.redis.quit();
  }
}
