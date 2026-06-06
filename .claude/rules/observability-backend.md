---
globs: "src/**/*.ts"
---

# Backend Observability

## Three Pillars

| Pillar | Tool | Purpose |
|--------|------|---------|
| **Logging** | `nestjs-pino` | Structured JSON logs with correlation IDs |
| **Metrics** | Prometheus via `prom-client` | Latency, error rates, token usage, cost |
| **Tracing** | OpenTelemetry → OTLP | Distributed traces across HTTP, Redis |

## Structured Logging

All logging uses Pino (`nestjs-pino`). All logs must be structured JSON (key-value pairs), not string interpolation.

```typescript
// ✅ CORRECT
this.logger.info({ model, inputTokens, costUsd, durationMs }, 'Generation completed');

// ❌ WRONG
this.logger.info('Generation completed for model ' + model);
```

**Log levels:**

| Level | When |
|-------|------|
| `error` | Unrecoverable — provider down, auth failed, DLQ events |
| `warn` | Degraded — retry triggered, circuit breaker half-open, timeout |
| `info` | Normal — request start/end, generation completed, embedding completed |
| `debug` | Dev-only — credentials refresh, cache key computed |

## Key Metrics (AI Gateway Specific)

- `ai_generate_duration_seconds` — generation latency histogram
- `ai_generate_requests_total` — request count by status
- `ai_tokens_total` — token consumption by model and direction
- `ai_cost_dollars` — cost accumulation by model
- `ai_circuit_breaker_state` — provider circuit breaker health
- `ai_embed_duration_seconds` — embedding latency histogram
- `ai_embed_requests_total` — embedding request count
- `ai_embed_inputs_total` — embedding input count

## Pino HTTP Serializers

HTTP request/response logs are stripped to safe fields only:
- **Request:** `id`, `method`, `url`
- **Response:** `statusCode`

## OpenTelemetry

OTel SDK initialized in `src/tracing.ts`, imported as first line of `main.ts`. Auto-instrumentations cover HTTP, Express, ioredis, Pino.

- Configure via: `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`
- `fs` instrumentation disabled (noisy)

## NEVER

- **NEVER** use `console.log` — use Pino via `@InjectPinoLogger()`
- **NEVER** use unstructured log messages — structured JSON only
- **NEVER** log API keys, OAuth tokens, or credentials
- **NEVER** import modules before `./tracing` in `main.ts`
