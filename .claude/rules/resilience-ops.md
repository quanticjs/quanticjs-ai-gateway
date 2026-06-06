---
globs: "src/**/*.ts"
---

# Resilience & Operations Patterns

## Health Probes

`QuanticHealthModule.forRoot()` provides three Kubernetes probes:

| Probe | Path | Checks | Purpose |
|---|---|---|---|
| Liveness | `/health/live` | Event loop only | Is the process alive? |
| Readiness | `/health/ready` | Redis (auto-detected) | Can it serve traffic? |
| Startup | `/health/startup` | User-configured | Has initialization completed? |

**Shutdown-aware:** On SIGTERM, readiness flips to 503 immediately, waits `shutdownDelayMs` (5s), then drains.

## Circuit Breaker

All outbound HTTP calls to external services (Anthropic API, TEI, etc.) must use `createCircuitBreaker()`:

```typescript
import { createCircuitBreaker } from '@quanticjs/core';

this.breaker = createCircuitBreaker({
  maxRetries: 2,
  consecutiveFailures: 5,
  halfOpenAfterMs: 30_000,
  onStateChange: (state) =>
    this.metrics.circuitBreakerState.set({ provider: 'anthropic-api' }, BREAKER_STATE[state] ?? 0),
});

const result = await this.breaker.execute(() => this.callApi(request));
```

**States:** Closed (normal) → Open (fast-fail) → Half-open (test one) → Closed on success.

**Where to apply in AI Gateway:**

| Provider | Circuit breaker? |
|---|---|
| AnthropicProvider | Yes |
| SdkProvider | Yes |
| TeiProvider | Yes |
| Redis | No — ioredis has built-in retry |

## Timeouts

Every outbound HTTP call must have an `AbortController` timeout:

```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
const response = await fetch(url, { signal: controller.signal });
clearTimeout(timeout);
```

## NEVER

- **NEVER** make liveness depend on external services — liveness checks process only
- **NEVER** skip `QuanticHealthModule.forRoot()` in `app.module.ts`
- **NEVER** make outbound HTTP calls without a circuit breaker
- **NEVER** retry 4xx responses — they are deterministic client errors
- **NEVER** share a circuit breaker across providers
- **NEVER** wrap Redis calls in a circuit breaker — ioredis retries internally
