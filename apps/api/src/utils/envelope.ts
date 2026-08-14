import { getCorrelationId } from '../middlewares/correlation.middleware';
import crypto from 'crypto';

export function createEnvelope(type: string, payload: any) {
  return {
    eventId: crypto.randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    correlationId: getCorrelationId(),
    payload
  };
}
