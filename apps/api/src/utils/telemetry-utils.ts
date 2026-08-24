import { trace, context, propagation, SpanStatusCode, SpanKind } from '@opentelemetry/api';

export function runInTrace<T>(
  name: string,
  metadata: Record<string, string> | undefined,
  kind: SpanKind,
  fn: () => Promise<T>
): Promise<T> {
  const tracer = trace.getTracer('tradealpha');
  
  let parentContext = context.active();
  if (metadata) {
    parentContext = propagation.extract(parentContext, metadata);
  }

  return new Promise<T>((resolve, reject) => {
    context.with(parentContext, () => {
      tracer.startActiveSpan(name, { kind }, async (span) => {
        try {
          const result = await fn();
          span.setStatus({ code: SpanStatusCode.OK });
          resolve(result);
        } catch (error: any) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          reject(error);
        } finally {
          span.end();
        }
      });
    });
  });
}
