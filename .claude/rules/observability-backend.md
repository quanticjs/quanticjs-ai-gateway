---
globs: "src/**/*.ts"
---

# Backend Observability

## Three Pillars

| Pillar | Tool | Purpose |
|--------|------|---------|
| **Logging** | ELK via `nestjs-pino` | Structured JSON logs with correlation IDs |
| **Metrics** | Prometheus + Grafana | Latency, error rates, Kafka consumer lag |
| **Tracing** | OpenTelemetry → OTLP (Jaeger dev / Elasticsearch APM prod) | Distributed traces across HTTP, CQRS, Redis, Kafka |

## Structured Logging

All logging uses Pino (`nestjs-pino`). Every request gets a `requestId` propagated through the CQRS pipeline. All logs must be structured JSON (key-value pairs), not string interpolation.

```typescript
// ✅ CORRECT
this.logger.info({ userId }, 'User created');

// ❌ WRONG
this.logger.info('User created: ' + userId);
```

**Log levels:**

| Level | When |
|-------|------|
| `error` | Unrecoverable failures — DB down, DLQ events, uncaught exceptions |
| `warn` | Degraded operation — retry triggered, cache miss on hot path, slow query (>1s) |
| `info` | Normal operation — request start/end, command executed, event published |
| `debug` | Dev-only — query params, cache key computed, lock acquired |

## CQRS Pipeline Logging

Automatic via `LogBehavior`: one structured entry per command/query with name, duration, result, correlationId, userId.

## Sensitive Field Handling (LogBehavior)

The `LogBehavior` pipeline step handles sensitive data automatically at three levels:

**1. Built-in PII masking (automatic — no configuration needed):**

These fields are auto-detected and masked in every command/query payload:

| Field name | Masking |
|------------|---------|
| `email` | `j***@example.com` (first char + domain) |
| `password` | `[REDACTED]` |
| `token` | `[REDACTED]` |
| `accessToken` | `[REDACTED]` |
| `githubAccessToken` | `[REDACTED]` |
| `secretKey` | `[REDACTED]` |

**2. Per-command field exclusion (`logExclude`):**

Commands can exclude additional fields via a static property. Excluded fields show `[excluded]` in logs:

```typescript
export class CreateIntegrationCommand {
  static logExclude = ['webhookSecret', 'apiKey'];

  constructor(
    readonly name: string,
    readonly webhookSecret: string,
    readonly apiKey: string,
  ) {}
}
// Logs: { name: "Stripe", webhookSecret: "[excluded]", apiKey: "[excluded]" }
```

**3. Suppressing entire payload (`@Log({ logPayload: false })`):**

For commands where the entire payload is sensitive, disable payload logging — only metadata (name, duration, result status) is logged:

```typescript
@Log({ logPayload: false })
@Validate(BulkImportValidator)
export class BulkImportCommand {
  constructor(readonly records: SensitiveRecord[]) {}
}
```

## Payload Sanitization (automatic)

LogBehavior sanitizes all payloads before logging:

| Rule | Behavior |
|------|----------|
| Strings > 200 chars | Truncated: `"value..."` + `(N chars)` |
| Arrays > 5 items | First 5 items + `"... +N more"` |
| Object depth > 2 | Nested objects show `[nested]` |

## Pino HTTP Serializers

HTTP request/response logs are stripped to safe fields only:
- **Request:** `id`, `method`, `url`, `correlationId`
- **Response:** `statusCode`

No headers, bodies, or query parameters are logged at the HTTP layer.

## Handler Skip — Not Supported

There is no mechanism to skip logging for an entire handler. All commands/queries pass through `LogBehavior`. Use `@Log({ logPayload: false })` to suppress payload if needed.

## Key Metrics

- `http_request_duration_seconds`, `http_requests_total`
- `cqrs_command_duration_seconds`, `cqrs_command_errors_total`
- `kafka_consumer_lag`, `kafka_dlq_messages_total`
- `typeorm_query_duration_seconds`

## Alerting Thresholds

| Alert | Condition | Severity |
|-------|-----------|----------|
| High API latency | p95 > 2s for 5 min | Warning |
| API error rate | 5xx > 5% for 5 min | Critical |
| Kafka consumer lag | Lag > 1000 for 10 min | Warning |
| DLQ growing | DLQ messages > 100 in 1 hour | Critical |
| Connection pool exhausted | Active > 90% pool | Critical |
| Pod OOM kill | Container OOMKilled restart | Critical |

## OpenTelemetry

OTel SDK is initialized in `src/tracing.ts`, imported as the first line of `main.ts`. Auto-instrumentations cover HTTP, Express, pg, ioredis, and Pino. The Pino instrumentation injects `trace_id` and `span_id` into every log entry automatically — no manual correlation needed.

- Jaeger UI at `http://localhost:16686` in local dev
- Configure via standard env vars: `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`
- `fs` instrumentation is disabled (noisy)

## NEVER

- **NEVER** use `console.log` in application code — use Pino via the injected logger
- **NEVER** use unstructured log messages — all logs must be structured JSON key-value pairs
- **NEVER** log sensitive data (passwords, tokens, PII) — use `logExclude` or `@Log({ logPayload: false })`
- **NEVER** rely solely on built-in PII masking for domain-specific secrets — add them to `logExclude`
- **NEVER** leave critical paths without alerting
- **NEVER** import application modules before `./tracing` in `main.ts` — OTel must patch modules before they load
- **NEVER** add manual trace context propagation — auto-instrumentations handle it
