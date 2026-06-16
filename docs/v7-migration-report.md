# QuanticJS v7.0.0 Migration Report — ai-gateway

**Date:** 2026-06-10
**Commits:** `6e11a8e` (dependency bump), `6e47b70` (migration fixes)
**Status:** Complete and verified locally. **Not deployed.**

The upgrade is committed in two commits. Build green, all 60 tests pass, and the booted app's pipeline-integrity summary is healthy: `9 command / 6 query behaviors, CqrsModule entries=1, buses patched=yes`, with **zero** `Result.unauthorized` / "No execution context" / "Duplicate behavior registration" lines across the whole verification run.

## Changes made, by migration-guide section

### §1 Dependencies

- All six `@quanticjs/*` packages bumped `^6.6.2 → ^7.0.0` in one commit; `npm ls @quanticjs/core` shows exactly one deduped `7.0.0` instance.
- Added **`@quanticjs/redis@7.0.0`** explicitly — the v7 umbrella no longer pulls it transitively, and without it `QuanticModule.forRoot({ redis })` boots Redis-less with a warning.
- `prom-client` was already a direct dependency (peer requirement satisfied).

### §2/§4 Auth & tenant hardening

- Wired `JwtStrategy` + global `JwtAuthGuard` + `AuthContextInterceptor` in `app.module.ts`.
- Verified: requests without a Bearer token get 401; with a valid token the full pipeline runs. Health probes remain `@Public()`.
- No `TenantContextMiddleware` or `X-Tenant-ID` usage existed.

### §3 AllowAnonymous, §5 pipeline integrity, §6 module hygiene, §11 locks, §12 workflow

Audit found nothing to fix: no `@AllowAnonymous()`, no static `CqrsModule` imports (removed in `7b780f4`), no bus dispatch from `onModuleInit`/constructors, no `UnleashModule`, no module re-export forwarding, no `@DistributedLock`, no workflow `fallback: 'queue'`.

### §7 Logging

- No bare `@Log()` or static `logExclude` existed, but v7's payload-logging default flip would have silently dropped all operational fields from command logs.
- Added explicit allowlists:
  - `@Log({ logPayload: true, logInclude: ['model', 'maxTokens', 'purpose', 'callerService'] })` on `GenerateSyncCommand` and `SubmitGenerationCommand`
  - `@Log({ logPayload: true, logInclude: ['callerService'] })` on `EmbedTextsCommand`
- Prompts and embedding inputs deliberately never reach logs. Verified in the live log: `payload: { "callerService": "verify" }` only.

### §9/§10 Kafka consumer & wire format

- Removed the `typeof event.payload === 'string' ? JSON.parse(...)` compensation in `AiRequestConsumer.mapToCommand` — the v7 `KafkaEventConsumer` decodes pre-v7 double-encoded payloads itself (compat bridge, removed one minor release after v7).
- Verified end-to-end: produced a command to `quantic.commands.ai-generate`, the consumer dispatched `SubmitGenerationCommand` through the pipeline (LogBehavior entry present, internal caller context, no auth errors), and the resulting `generation.failed` event landed on `quantic.events.generations.verify` in the new single-encoded envelope.

### Framework gap found (workaround applied)

v7's `QuanticEventsCoreModule` registers `OutboxPublisher` unconditionally and its `DataSource` constructor param is **not** `@Optional()`, so this DB-less app failed boot even with `outbox: false`.

Workaround: `NoDatabaseModule` in `app.module.ts` provides `{ provide: DataSource, useValue: null }` — safe because the app publishes via `EVENT_PUBLISHER` directly and never calls `publishViaOutbox()`.

**Follow-up ticket: file an issue against `@quanticjs/events-core` and remove the workaround once `DataSource` is optional** (the SPEC shows `@Optional()` on `InboxService` but the published `OutboxPublisher` lacks it).

## Verification details

Booted against throwaway Redis + Kafka containers and a local JWKS issuer/TEI stub (cleaned up afterward).

- Readiness reported `redis: ok, kafka_consumers: ok`.
- Exercised: HTTP embed (success), HTTP generate (provider failure surfaced cleanly as RFC 9457 500 — dummy API key, expected), Kafka consume → dispatch → event publish.
- A LogBehavior entry was confirmed for every command on both HTTP and Kafka paths. Note: v7's LogBehavior emits one structured entry per command at completion (with duration and payload), rather than separate entry/exit lines.
- This app has no nested command-from-command dispatch, so HTTP (`external`) and Kafka (`internal`) cover both caller types.

## Items needing a human before deploy

1. **Env vars (production boot fails without them):** `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_AUDIENCE`. Optionally `KEYCLOAK_ORG_CLAIM` (default `organization_id`) and `KEYCLOAK_CLIENT_ID` (needed for permissions extraction from `resource_access`).
2. **Keycloak mappers:** an org-claim user-attribute protocol mapper emitting `organization_id` into access tokens, and an audience mapper so tokens carry this service's `aud` value matching `KEYCLOAK_AUDIENCE`.
3. **Callers of this service** (e.g., delivery-hub) must send client-credentials Bearer tokens **with ai-gateway's audience** — unauthenticated service-to-service calls now fail loudly at this callee. Admin realm role no longer bypasses `@Permission(...)`; grant real client roles if any caller relies on admin bypass.
4. **Kafka topics:** create `quantic.commands.ai-generate.dlq` (30-day retention recommended) in every environment **before** rolling out — failed pipeline Results now retry and dead-letter instead of being silently committed. Add alerting on `quanticjs_events_dlq_total`. A crashed consumer now turns readiness red, so Kubernetes will restart pods that previously tolerated a dead consumer.
5. **Dashboards:** no `arex_*` metrics were used here, but any dashboards reading pipeline metrics should switch to `quanticjs_command_duration_seconds`, and Kafka consumer dashboards need the `retry` → `retried` label rename. This app's custom `ai_*` metrics are unchanged.
6. **Not applicable to this app** (no DB, no locks, no workflow engine): outbox/inbox migrations, `callbackSecret`/`rawBody: true`, and the §11 lock-key rolling-deploy window. No action needed.

## Temporary bridges / follow-up tickets

- **`NoDatabaseModule` null-`DataSource` workaround** (described above) — remove when the framework makes it optional. This is the only bridge; `integrity: 'warn'` and `payloadMode: 'redacted'` were **not** needed.
