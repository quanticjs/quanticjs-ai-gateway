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
| `error` | Unrecoverable failures — DB down, DLQ events, uncaught exceptions, **any Result resolving to HTTP 5xx** |
| `warn` | Degraded operation — retry triggered, cache miss on hot path, slow query (>1s), slow handler (> configured `slowThresholdMs`, default 500ms), 4xx Result failures |
| `info` | Normal operation — request start/end, command executed, event published |
| `debug` | Dev-only — query params, cache key computed, lock acquired |

## CQRS Pipeline Logging

Automatic via `LogBehavior`: one structured entry per command/query with name, duration, result, correlationId, userId, and orgId. **Payloads are not part of this entry unless the command opts in** (see below).

## Payload Logging — Deny by Default (v7)

Since `@quanticjs/core` v7, command/query payloads are **NOT logged unless the command class explicitly opts in**. With no `@Log` decorator and default config, the log entry contains no `payload` key at all (no placeholder object either).

**Opting in — `@Log` decorator options:**

```typescript
// Full payload, passed through the sensitive-field sanitizer
@Log({ logPayload: true })
export class CreateOrderCommand { ... }

// Recommended: explicit allowlist — ONLY these top-level fields are logged
@Log({ logPayload: true, logInclude: ['orderId', 'status'] })
export class UpdateOrderCommand { ... }

// Exclude specific fields — replaced with '[excluded]' at ANY nesting depth, including arrays
@Log({ logPayload: true, logExclude: ['notes'] })
export class AnnotateOrderCommand { ... }
```

Resolution rules:

| Decorator | Payload logged? |
|---|---|
| *(none)* | No (unless global `payloadMode: 'redacted'`) |
| `@Log()` bare | No — `logPayload` defaults to `false` in v7 |
| `@Log({ logPayload: false })` | No (also overrides global `payloadMode: 'redacted'`) |
| `@Log({ logPayload: true, ... })` | Yes, through the sanitizer |

- `logInclude` selects top-level fields; nested content of included fields still passes through `logExclude` + the sensitive set at all depths. `logInclude: []` logs an empty `{}` — it does not fall back to the full payload.
- When both are set, `logInclude` selects first, `logExclude` then redacts within the result.
- The sensitive set **always wins** — `logInclude: ['email']` still partial-masks the email value.

**Global migration bridge** (temporary only — migrate command-by-command, then remove):

```typescript
QuanticCoreModule.forRoot({
  logging: {
    payloadMode: 'redacted',                      // v6-like: all payloads logged through the sanitizer
    additionalSensitiveFields: ['internalRef'],   // merged into the built-in set; cannot remove built-ins
  },
})
```

## Sensitive Field Handling (LogBehavior)

**Built-in sensitive set (automatic, applied even to opted-in payloads):** exactly 40 fields — `password`, `passwd`, `secret`, `secretKey`, `token`, `accessToken`, `refreshToken`, `idToken`, `githubAccessToken`, `authorization`, `apiKey`, `clientSecret`, `privateKey`, `cookie`, `sessionId`, `otp`, `pin`, `mfaCode`, `securityAnswer`, `email`, `phone`, `phoneNumber`, `mobile`, `dateOfBirth`, `dob`, `ssn`, `nationalId`, `taxId`, `passportNumber`, `iban`, `pan`, `cardNumber`, `cvv`, `cvc`, `accountNumber`, `routingNumber`, `sortCode`, `bic`, `swift`, `address`.

**Matching is normalized** — lowercase with non-alphanumerics stripped — so `card_number`, `CardNumber`, and `CARDNUMBER` all redact. `email` keeps the partial-mask format (`j***@example.com`); all other matches become `[REDACTED]`. Redaction applies at every depth up to `MAX_DEPTH`, including inside arrays.

**Domain-specific secrets:** add via `additionalSensitiveFields` in `QuanticCoreModule.forRoot({ logging })` (app-wide, normalized matching) or per-command `logExclude`.

> The v6 `static logExclude` class property is **no longer read** — `LogBehavior` reads `@Log` decorator metadata only. Search for `static logExclude` and convert to `@Log({ logPayload: true, logExclude: [...] })`.

## Payload Sanitization (automatic)

LogBehavior sanitizes all opted-in payloads before logging:

| Rule | Behavior |
|------|----------|
| Strings > 200 chars | Truncated: `"value..."` + `(N chars)` |
| Arrays > 5 items | First 5 items + `"... +N more"` |
| Nesting depth | Objects nested ≥ 2 levels below the payload root are replaced with `'[nested]'` (arrays don't consume a depth level — redaction reaches object keys inside arrays; only arrays-in-arrays do) |

## Production Error Masking (server-side half)

In production, `ResultInterceptor` masks any response with resolved status >= 500 (`detail: 'An unexpected error occurred.'` + `correlationId`) — see `api-patterns.md` for the HTTP contract. The **full** `result.errorMessage` is always retained server-side: `logger.error` for 5xx, `logger.warn` for 4xx. Debug masked 500s by grepping logs for the `correlationId` from the response.

## Pino HTTP Serializers

HTTP request/response logs are stripped to safe fields only:
- **Request:** `id`, `method`, `url`, `correlationId`
- **Response:** `statusCode`

No headers, bodies, or query parameters are logged at the HTTP layer.

## Handler Skip — Not Supported

There is no mechanism to skip logging for an entire handler. All commands/queries pass through `LogBehavior`. Payloads are already suppressed by default; metadata (name, duration, result status) is always logged.

## Metrics — Shared Prometheus Registry

All collectors register against the **prom-client default global registry** (`promClient.register`). `MetricsService` and `KafkaEventMetrics` both use it; `MetricsController` serves it at `/metrics`.

- **NEVER create a private `new Registry()`** in a service or package — series registered there are invisible to the scrape endpoint. The `METRICS_REGISTRY` injection token exists solely for test isolation.
- **Collector creation must be idempotent**: check `registry.getSingleMetric(name)` and reuse — a double `forRoot()` or test re-bootstrap must not throw `already been registered`.
- `prom-client` is a `peerDependency` of metrics-emitting packages. Two hoisted copies = two default registries = invisible metrics; symptom check: `npm ls prom-client`.
- Pipeline behaviors inject `@Optional() @Inject(PIPELINE_METRICS)` and **no-op when `@quanticjs/metrics` is absent** — metrics are never load-bearing.

## Key Metrics (v7 contract)

Framework metrics use the `quanticjs_` prefix. Never emit application-specific namespaces (e.g. `arex_*`) from shared code.

| Name | Type | Labels |
|---|---|---|
| `quanticjs_commands_total` | Counter | `class`, `status` ∈ `success\|failure\|exception` |
| `quanticjs_command_duration_seconds` | Histogram | `class`, `status` |
| `quanticjs_cache_hits_total` / `quanticjs_cache_misses_total` | Counter | `class` |
| `quanticjs_lock_wait_seconds` | Histogram | `class` |
| `quanticjs_lock_failures_total` | Counter | `class`, `reason` ∈ `timeout\|backend_error\|lost` |
| `quanticjs_validation_failures_total` | Counter | `class` |
| `quanticjs_events_published_total` | Counter | `topic` |
| `quanticjs_events_consumed_total` | Counter | `topic`, `group`, `status` ∈ `success\|retried\|dlq\|failed\|duplicate` |
| `quanticjs_events_processing_duration_seconds` | Histogram | `topic`, `group` |
| `quanticjs_events_dlq_total` | Counter | `topic`, `error_category` ∈ `DESERIALIZATION\|PROCESSING\|PERMANENT` |
| `quanticjs_events_consumer_lag` | Gauge | `topic`, `group`, `partition` |
| `quanticjs_events_last_processed_timestamp_seconds` | Gauge | `topic`, `group` |

The framework emits only `quanticjs_*` series. HTTP and TypeORM query metrics are the consumer app's responsibility (e.g., express middleware / custom interceptor registered against the default registry).

**Cardinality rule:** labels must be bounded enums or class names (`command.constructor.name`). **NEVER label metrics by payload values** (user IDs, order IDs, free text).

`PerformanceBehavior` records duration/status in `try/finally` — exceptions get `status="exception"` and still propagate. Slow-handler threshold is configurable via `QuanticMetricsModule.forRoot({ slowThresholdMs })` (default 500). The slow-handler warn log is emitted by `PerformanceBehavior` — it requires `@quanticjs/metrics` to be installed.

## Alerting Thresholds

| Alert | Condition | Severity |
|-------|-----------|----------|
| High API latency | p95 > 2s for 5 min | Warning |
| API error rate | 5xx > 5% for 5 min | Critical |
| Kafka consumer lag | `quanticjs_events_consumer_lag` > 1000 for 10 min | Warning |
| Stuck consumer | `time() - quanticjs_events_last_processed_timestamp_seconds > X` **AND** `quanticjs_events_consumer_lag > 0` | Critical |
| DLQ growing | `quanticjs_events_dlq_total` increase > 100 in 1 hour | Critical |
| Connection pool exhausted | Active > 90% pool | Critical |
| Pod OOM kill | Container OOMKilled restart | Critical |

Lag alone cannot detect a stuck-but-assigned consumer — pair it with the last-processed-timestamp expression as shown.

## OpenTelemetry

OTel SDK is initialized in `src/tracing.ts`, imported as the first line of `main.ts`. Auto-instrumentations cover HTTP, Express, pg, ioredis, and Pino. The Pino instrumentation injects `trace_id` and `span_id` into every log entry automatically — no manual correlation needed.

- Jaeger UI at `http://localhost:16686` in local dev
- Configure via standard env vars: `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`
- `fs` instrumentation is disabled (noisy)

## NEVER

- **NEVER** use `console.log` in application code — use Pino via the injected logger
- **NEVER** use unstructured log messages — all logs must be structured JSON key-value pairs
- **NEVER** opt a payload into logging without checking its fields — prefer `@Log({ logPayload: true, logInclude: [...] })` allowlists over full-payload logging
- **NEVER** use the v6 `static logExclude` class property — it is dead code; use `@Log({ logExclude: [...] })`
- **NEVER** rely solely on built-in PII masking for domain-specific secrets — add them via `additionalSensitiveFields` or `logExclude`
- **NEVER** create a private prom-client `Registry` outside tests — register against the shared default registry
- **NEVER** label metrics by command payload values — bounded enums and class names only
- **NEVER** leave critical paths without alerting
- **NEVER** import application modules before `./tracing` in `main.ts` — OTel must patch modules before they load
- **NEVER** add manual trace context propagation — auto-instrumentations handle it
