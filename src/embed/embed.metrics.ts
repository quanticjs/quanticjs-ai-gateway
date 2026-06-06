import { Injectable } from '@nestjs/common';
import { Histogram, Counter, Gauge } from 'prom-client';

@Injectable()
export class EmbedMetrics {
  readonly requestDuration = new Histogram({
    name: 'ai_embed_duration_seconds',
    help: 'Embedding request duration in seconds',
    labelNames: ['model', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  });

  readonly inputsTotal = new Counter({
    name: 'ai_embed_inputs_total',
    help: 'Total embedding inputs processed',
    labelNames: ['model'] as const,
  });

  readonly requestsTotal = new Counter({
    name: 'ai_embed_requests_total',
    help: 'Total embedding requests',
    labelNames: ['status'] as const,
  });

  readonly circuitBreakerState = new Gauge({
    name: 'ai_embed_circuit_breaker_state',
    help: 'Embedding circuit breaker state (0=closed, 1=half-open, 2=open)',
    labelNames: ['provider'] as const,
  });
}
