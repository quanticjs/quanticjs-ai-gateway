import { Injectable } from '@nestjs/common';
import { Histogram, Counter, Gauge } from 'prom-client';

@Injectable()
export class GenerateMetrics {
  readonly requestDuration = new Histogram({
    name: 'ai_generate_duration_seconds',
    help: 'AI generation duration in seconds',
    labelNames: ['model', 'status'] as const,
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120],
  });

  readonly tokensTotal = new Counter({
    name: 'ai_tokens_total',
    help: 'Total AI tokens consumed',
    labelNames: ['model', 'direction'] as const,
  });

  readonly costDollars = new Counter({
    name: 'ai_cost_dollars',
    help: 'Accumulated AI cost in USD',
    labelNames: ['model'] as const,
  });

  readonly requestsTotal = new Counter({
    name: 'ai_generate_requests_total',
    help: 'Total AI generation requests',
    labelNames: ['status'] as const,
  });

  readonly circuitBreakerState = new Gauge({
    name: 'ai_circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
    labelNames: ['provider'] as const,
  });
}
