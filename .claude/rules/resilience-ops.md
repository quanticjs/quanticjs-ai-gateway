---
globs: "src/**/*.ts"
---

# Resilience & Operations Patterns

## Health Probes

Every service imports `QuanticHealthModule.forRoot()` in `app.module.ts`. It provides three Kubernetes probes:

| Probe | Path | Checks | Purpose |
|---|---|---|---|
| Liveness | `/health/live` | Event loop only | Is the process alive? Restart if not. |
| Readiness | `/health/ready` | DB + Redis (auto-detected) + custom | Can it serve traffic? Remove from LB if not. |
| Startup | `/health/startup` | User-configured | Has initialization completed? |

**Auto-detection:** If `DataSource` or `REDIS_CLIENT` is in the DI container, readiness checks are registered automatically. Disable with `autoDetect: false`.

**Transport modes:**
- `controller` (default) — mounts on existing NestJS server, routes are `@Public()`
- `standalone` — separate `http.createServer` on dedicated port (for workers/queue consumers)
- `file` — writes to `/tmp/.healthy` on interval (for cron jobs)
- `none` — programmatic access only via `HealthRegistry`

**Custom checks:**
```typescript
QuanticHealthModule.forRoot({
  readiness: [
    { name: 'minio', check: () => minioClient.bucketExists('uploads'), timeoutMs: 5000 },
    { name: 'payments', url: 'http://payments:3000/health/live', timeoutMs: 3000 },
  ],
})
```

**Shutdown-aware:** On SIGTERM, readiness flips to 503 immediately, waits `shutdownDelayMs` (default 5s) for LB to stop routing, then `GracefulShutdownService` drains resources.

## Graceful Shutdown

On SIGTERM, shutdown runs in two phases. A Kubernetes preStop hook (`sleep 5`) runs first at the K8s level — before SIGTERM reaches the application:

```
preStop hook: sleep 5s (K8s level — before app receives SIGTERM)
  → SIGTERM → Phase 1: readiness → 503 (no additional delay needed)
             → Phase 2: drainWork() → close DB → close Redis → exit
```

Services with custom resources (queues, websockets, outbox publisher) override `drainWork()`:

```typescript
@Injectable()
export class AppShutdownService extends GracefulShutdownService {
  constructor(
    @Optional() dataSource: DataSource,
    @Optional() @Inject('REDIS_CLIENT') redis: Redis,
    private readonly queueWorker: Worker,
  ) {
    super(dataSource, redis);
  }

  protected async drainWork(): Promise<void> {
    await this.queueWorker.close(); // stop accepting jobs, wait for in-progress
  }
}
```

**Kubernetes alignment:** `terminationGracePeriodSeconds` must exceed `shutdownDelayMs + drainTimeout + buffer` (default: 45s in Helm chart).

## Circuit Breaker

All outbound HTTP calls to external services must use `createCircuitBreaker()`:

```typescript
import { createCircuitBreaker } from '@quanticjs/core';

const policy = createCircuitBreaker({
  maxRetries: 2,              // 3 total attempts, exponential backoff
  consecutiveFailures: 5,     // open circuit after 5 consecutive failures
  halfOpenAfterMs: 30_000,    // test one request after 30s
});

const result = await policy.execute(() => httpClient.get('/external-api'));
```

**States:** Closed (normal) → Open (fast-fail, no outbound calls) → Half-open (test one request) → Closed on success.

**Where to apply:**

| Integration | Circuit breaker? |
|---|---|
| Keycloak JWKS | Yes |
| Kogito workflow | Yes |
| Third-party APIs | Yes |
| Redis | No — ioredis has built-in retry |
| TypeORM / DB | No — connection pool retries internally |

**Fallback when circuit is open:**

| Integration | Fallback |
|---|---|
| Keycloak JWKS | Use cached JWKS (last known good) — JWTs validated with cached keys for the key rotation period |
| External API (non-critical) | Return degraded response or cached data. Log the degradation. |
| External API (critical) | Return `Result.failure(ErrorType.ServiceUnavailable, 'Service temporarily unavailable')` |
| Workflow engine | Queue the command for later execution. Do not block the user. |

**Bulkhead (future):** For integrations with >50 req/s, consider adding a concurrency limiter alongside the circuit breaker. cockatiel supports `bulkhead(maxConcurrent, maxQueue)` — wrap with the circuit breaker to prevent slow (not failing) dependencies from exhausting the caller's connection pool.

## NEVER

- **NEVER** make liveness depend on external services (DB, Redis) — liveness checks the process only; dependency failures go in readiness
- **NEVER** skip `QuanticHealthModule.forRoot()` in `app.module.ts` — every service needs health probes
- **NEVER** exit on SIGTERM without draining — extend `GracefulShutdownService` and close custom resources in `drainWork()`
- **NEVER** make outbound HTTP calls to external services without a circuit breaker
- **NEVER** retry 4xx responses — they are deterministic client errors
- **NEVER** share a circuit breaker across integrations — one failing service must not trip the circuit for healthy ones
- **NEVER** wrap Redis or TypeORM calls in a circuit breaker — they have built-in retry/reconnect
