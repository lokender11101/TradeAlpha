import dotenv from "dotenv";
dotenv.config();
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import * as promClient from 'prom-client';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { SocketIoInstrumentation } from '@opentelemetry/instrumentation-socket.io';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { BatchSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

// Set up metrics
export const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry });

let sdk: NodeSDK | null = null;

export function setupTelemetry(serviceName: string) {
  if (sdk) {
    return;
  }

  if (process.env.DISABLE_TELEMETRY === 'true') {
    return;
  }

  if (process.env.OTEL_LOG_LEVEL === 'debug') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const resource = resourceFromAttributes({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
  });

  const exporter = process.env.OTLP_ENDPOINT
    ? new OTLPTraceExporter({ url: process.env.OTLP_ENDPOINT })
    : new OTLPTraceExporter(); 

  sdk = new NodeSDK({
    resource,
    spanProcessor: new BatchSpanProcessor(exporter, {
      maxQueueSize: 2048,
      scheduledDelayMillis: 1000,
      exportTimeoutMillis: 5000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-pino': { enabled: true },
      }),
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new SocketIoInstrumentation(),
      new IORedisInstrumentation(),
      new PrismaInstrumentation(), 
    ],
  });

  try {
    sdk.start();
    console.log(`[Telemetry] OpenTelemetry initialized for ${serviceName}`);
  } catch (error) {
    console.error(`[Telemetry] Error initializing OpenTelemetry for ${serviceName}`, error);
  }

  process.on('SIGTERM', () => {
    sdk?.shutdown()
      .then(() => console.log(`[Telemetry] Terminated ${serviceName}`))
      .catch((error) => console.log(`[Telemetry] Error terminating ${serviceName}`, error))
      .finally(() => process.exit(0));
  });
}

export const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry],
});

export const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry],
});

export const ordersAccepted = new promClient.Counter({
  name: 'tradealpha_orders_accepted_total',
  help: 'Total orders successfully accepted by the engine',
  labelNames: ['symbol'],
  registers: [metricsRegistry],
});

export const ordersRejected = new promClient.Counter({
  name: 'tradealpha_orders_rejected_total',
  help: 'Total orders rejected by the engine',
  labelNames: ['symbol', 'reason'],
  registers: [metricsRegistry],
});

export const executionsAttempted = new promClient.Counter({
  name: 'tradealpha_executions_attempted_total',
  help: 'Total executions attempted',
  labelNames: ['symbol'],
  registers: [metricsRegistry],
});

export const partialFills = new promClient.Counter({
  name: 'tradealpha_partial_fills_total',
  help: 'Total partial fills executed',
  labelNames: ['symbol'],
  registers: [metricsRegistry],
});

export const fullFills = new promClient.Counter({
  name: 'tradealpha_full_fills_total',
  help: 'Total full fills executed',
  labelNames: ['symbol'],
  registers: [metricsRegistry],
});

export const activeWebsocketClients = new promClient.Gauge({
  name: 'tradealpha_active_websocket_clients',
  help: 'Currently connected WebSocket clients',
  registers: [metricsRegistry],
});

export const bullmqQueueDepth = new promClient.Gauge({
  name: 'bullmq_queue_depth',
  help: 'Depth of BullMQ queues',
  labelNames: ['queue_name'],
  registers: [metricsRegistry],
});

export const bullmqJobProcessingTime = new promClient.Histogram({
  name: 'bullmq_job_processing_time_seconds',
  help: 'Processing time of BullMQ jobs',
  labelNames: ['queue_name', 'job_name'],
  registers: [metricsRegistry],
});

export const bullmqFailedJobs = new promClient.Counter({
  name: 'bullmq_failed_jobs_total',
  help: 'Total failed BullMQ jobs',
  labelNames: ['queue_name', 'job_name'],
  registers: [metricsRegistry],
});
