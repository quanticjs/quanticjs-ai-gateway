---
globs: "src/**/*.ts"
---

# Resilience & Operations Patterns

## Health Probes

Every service imports `QuanticHealthModule.forRoot()` in `app.module.ts`. It provides three Kubernetes probes:

| Probe | Path | Checks | Purpose |
|---|---|---|---|
| Liveness | `/health/live` | Event loop only | Is the process alive? Restart if not. |
| Readiness | `/health/ready` | DB + Redis + Kafka consumers (auto-detected) + custom | Can it serve traffic? Remove from LB if not. |
| Startup | `/health/startup` | User-configured | Has initialization completed? |

**Auto-detection:** If `DataSource`, `REDIS_CLIENT`, or `KAFKA_CONSUMER_STATUS` is in the DI container, readiness checks are registered automatically (the Kafka one as `kafka_consumers`). Disable with `autoDetect: false`. Crash visibility is bounded by the health report cache TTL (default 5000ms).

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

For Kafka-consumer services, also surface a DLQ-blocked consumer (see below) as a custom readiness check via the consumer's `isDlqBlocked()`.

**Shutdown-aware:** On SIGTERM, readiness flips to 503 immediately, waits `shutdownDelayMs` (default 5s) for LB to stop routing, then `GracefulShutdownService` drains resources.

## Kafka Consumer Health & Boot

The consumer tracks a status: `connecting | running | crashed | disconnected`.

- A rejected run-loop sets `crashed` → the `kafka_consumers` readiness check fails within one health-cache TTL → readiness 503 → the pod is removed from load balancing. There is no in-process auto-restart of a crashed consumer, and readiness alone does not restart the pod — recovery requires a pod replacement (alert on `kafka_consumers` readiness / `quanticjs_events_last_processed_timestamp_seconds`, or run with `dlqFailurePolicy: 'crash'` / a liveness signal if automated restart is required).
- `connecting` and `disconnected` are never flagged — the readiness check fails only on `crashed`.
- **Status-registry wiring:** the `kafka_consumers` check only covers consumers that pass `KafkaConsumerStatusRegistry` as the 5th `super()` arg; consumers built with `super(config, metrics)` register nothing and are invisible to readiness.
- **Boot connect retry:** `onModuleInit` retries `connect()` with exponential backoff ×2 + full jitter (`connectRetries` default 5, base 1000ms, cap 30000ms). After exhaustion: `connectFailurePolicy: 'fail'` (default) throws — boot crash; `'degrade'` boots anyway with background retries (`unref()`ed timers, cancelled in `onModuleDestroy`) — note `'degrade'` pods are readiness-red from boot (status `crashed`, reason `connect_failed`) until a background retry succeeds.
- **DLQ-blocked consumers:** when a DLQ publish fails, the consumer pauses the topic (`dlqFailurePolicy: 'pause'`, default) and retries the DLQ publish; the blocked offset is **never committed**. Expose `isDlqBlocked()` through readiness. The `'crash'` policy instead exits so K8s restarts and the uncommitted offset is reprocessed.
- **Shutdown/rebalance semantics:** on shutdown while DLQ-blocked — cancel DLQ retry timers, do not commit the blocked offset, disconnect (redelivery on restart). On partition revoke — cancel pending DLQ retries for revoked partitions and never commit their offsets.

## Outbox Relay HA

The outbox relay is multi-replica safe by design (`FOR UPDATE SKIP LOCKED` claiming — see `database-patterns.md`). Do **not** add leader election or replica gating. A replica killed mid-batch rolls its claim transaction back; rows revert to Pending and the resulting duplicate publishes are absorbed by the consumer inbox.

## Graceful Shutdown

On SIGTERM, shutdown runs in two phases. A Kubernetes preStop hook (`sleep 5`) runs first at the K8s level — before SIGTERM reaches the application:

```
preStop hook: sleep 5s (K8s level — before app receives SIGTERM)
  → SIGTERM → Phase 1: readiness → 503 (no additional delay needed)
             → Phase 2: drainWork() → close DB → close Redis → exit
```

`GracefulShutdownService` lives in `@quanticjs/core`; `drainWork()` has a 30s internal timeout. Services with custom resources (queues, websockets, outbox publisher) override `drainWork()`:

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

**Boot-time integrity failures:** since v7, a misconfigured CQRS pipeline (dual `CqrsModule`, unpatched bus, zero behaviors) **fails boot by default**. The temporary unblock is `QuanticCoreModule.forRoot({ integrity: { mode: 'warn' } })` — see `backend-patterns.md` for the full treatment.

## Circuit Breaker

All outbound HTTP calls to external services must use `createCircuitBreaker()`:

```typescript
import { createCircuitBreaker } from '@quanticjs/core';

const policy = createCircuitBreaker({
  maxRetries: 2,              // 3 total attempts, exponential backoff
  consecutiveFailures: 5,     // open circuit after 5 consecutive failures
  halfOpenAfterMs: 30_000,    // test one request after 30s
  onStateChange: (state) => {},  // optional — observe open/half-open/closed transitions
});

const result = await policy.execute(() => httpClient.get('/external-api'));
```

**States:** Closed (normal) → Open (fast-fail, no outbound calls) → Half-open (test one request) → Closed on success.

**Timeouts are mandatory alongside the breaker.** A circuit breaker only sees *failing* calls — a hung call that never resolves keeps callers blocked forever. Every outbound fetch must carry an explicit timeout (`AbortSignal.timeout(ms)`, default budget 10s). Note: callers that previously "worked" by waiting indefinitely will see failures surfaced — that's the point.

**Single-flight token refresh.** Token services (Keycloak client-credentials, admin tokens) MUST coalesce concurrent refreshes into one in-flight promise, cleared in `finally` on rejection so the next caller retries fresh:

```typescript
private inFlight: Promise<string> | null = null;

async getAccessToken(): Promise<string> {
  if (this.accessToken && Date.now() < this.expiresAt - 30_000) return this.accessToken;
  if (!this.inFlight) {
    this.inFlight = this.fetchToken().finally(() => { this.inFlight = null; });
  }
  return this.inFlight;  // N concurrent callers share ONE request
}
```

**Where to apply:**

| Integration | Circuit breaker? |
|---|---|
| Keycloak JWKS / token endpoints | Yes (+ timeout + single-flight) |
| Workflow engine (QuanticFlow / Kogito) | Yes |
| Third-party APIs | Yes |
| Redis | No — ioredis has built-in retry |
| TypeORM / DB | No — connection pool retries internally |
| Kafka producer/consumer | No — the outbox absorbs producer-side unavailability; the consumer retry/DLQ/pause machinery handles the consume side |
| SDK-managed polling clients (Unleash, Kafka client) | No — the SDK owns its retry/poll loop; harden with error listeners and fallbacks instead |

**Fallback when circuit is open:**

| Integration | Fallback |
|---|---|
| Keycloak JWKS | Use cached JWKS (last known good) — JWTs validated with cached keys for the key rotation period |
| External API (non-critical) | Return degraded response or cached data. Log the degradation. |
| External API (critical) | Return `Result.failure(ErrorType.InternalError, 'Service temporarily unavailable')` — there is no `ServiceUnavailable` member in `ErrorType` |
| Workflow engine | `@Workflow(..., { fallback: 'skip' })` + outbox publish from the handler, or `fallback: 'throw'` → `Result.failure`. **There is no `'queue'` fallback** — it was removed from the API. |

## Feature-Flag (Unleash) Degradation

- `'error'` and `'warn'` listeners on the Unleash client are mandatory — an unhandled `'error'` event on the EventEmitter crashes the Node process. The framework attaches them in `forRoot()`; never construct the client manually without them.
- **Production fail-fast:** with `NODE_ENV=production` and the insecure default token or a localhost URL, boot **throws**. Set `UNLEASH_URL` + `UNLEASH_API_TOKEN` explicitly. Caveat: the check keys on `NODE_ENV === 'production'` — ops must set it.
- **Outage semantics are fail-closed:** when Unleash is unreachable and no bootstrap/backup exists, every `isEnabled()` is `false`; `@FeatureFlag` with default `fallback: 'throw'` returns `Result.failure(Forbidden)` for ALL guarded commands. Choose per flag: `'throw'` for kill-switch semantics (provider outage disables the feature — correct for risky features); `'skip'`/`'default'` for launched features that must survive a provider outage.
- Configure `bootstrap`/`backupPath` for last-known-good flag values across restarts during an outage.
- When `QuanticFeatureFlagsModule.forRoot()` is imported with no URL configured, the client still initializes against the insecure default `http://localhost:4242/api`; if unreachable, every guarded flag evaluates disabled (fail-closed). Flags are inert/pass-through only when the feature-flags module is not imported at all.

## Redis Streams Transport (non-critical eventing only)

If `@quanticjs/events-redis` is used at all, it is for **non-critical eventing only** (weaker guarantees than Kafka — no replication-acknowledged durability). Review and tune (defaults shown): `minIdleTimeMs` (60000 — orphan reclaim via `XAUTOCLAIM`; must exceed worst-case handler time), `reclaimIntervalMs` (30000), `maxDeliveries` (5) → dead-letter to `<streamKey>:dlq` (`XADD` before `XACK`, so a DLQ-write failure loses nothing). The publisher no longer trims with `MAXLEN` by default — retention is an explicit operational responsibility, and DLQ streams grow unbounded by design. Redis ≥ 6.2 is required for orphan reclaim (`XAUTOCLAIM`); on older Redis the consumer logs an error and degrades to startup-only PEL drain — entries owned by dead consumers are retried only on restart. Treat < 6.2 as unsupported. Unlike `KafkaEventConsumer`, Redis Streams consumers do NOT wrap `handleMessage` in `runAsService()` — commands dispatched from a `RedisStreamConsumer` get `Result.unauthorized` unless the app wraps them. Critical eventing uses Kafka — see `backend-patterns.md`.

## NEVER

- **NEVER** make liveness depend on external services (DB, Redis) — liveness checks the process only; dependency failures go in readiness
- **NEVER** skip `QuanticHealthModule.forRoot()` in `app.module.ts` — every service needs health probes
- **NEVER** exit on SIGTERM without draining — extend `GracefulShutdownService` and close custom resources in `drainWork()`
- **NEVER** make outbound HTTP calls to external services without a circuit breaker **and an explicit timeout** (SDK-managed polling clients excepted — see table)
- **NEVER** retry 4xx responses — they are deterministic client errors
- **NEVER** share a circuit breaker across integrations — one failing service must not trip the circuit for healthy ones
- **NEVER** wrap Redis or TypeORM calls in a circuit breaker — they have built-in retry/reconnect
- **NEVER** add leader election or replica gating to the outbox relay — `SKIP LOCKED` claiming already makes it multi-replica safe
- **NEVER** assume Redis is "only a cache" availability-wise — with fail-closed locks (v7), Redis down means every `@DistributedLock`-decorated command returns `Result.failure(InternalError)`; treat Redis availability as command availability on ops dashboards
