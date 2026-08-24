import { getCorrelationId } from '../middlewares/correlation.middleware';
import crypto from 'crypto';
import { propagation, context } from '@opentelemetry/api';

export function createEnvelope(type: string, payload: any) {
  const metadata: Record<string, string> = {};
  propagation.inject(context.active(), metadata);
  
  return {
    eventId: crypto.randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    correlationId: getCorrelationId(),
    metadata, // Add trace context here
    payload
  };
}
