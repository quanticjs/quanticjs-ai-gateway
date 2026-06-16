---
globs: "src/**/*.ts"
---

# Backend Patterns

## Modular Monolith

Two deployable artifacts: one NestJS backend image, one React frontend image. No microservices.

### Module Structure

```
src/
  <module>/           # Domain module (e.g., identity, billing)
  shared/             # Guards, filters, interceptors
```

BFF authentication is provided by `@quanticjs/auth-web-bff` (`BffModule.forRoot()` in `app.module.ts`) — not a local `src/bff/` directory.

### Module Boundary Rules

- Modules communicate through `CommandBus`/`QueryBus` — never import another module's services or repositories
- Each module owns its own PostgreSQL schema (e.g., `identity.*`, `billing.*`)
- Async inter-module communication uses Apache Kafka
- Only commands, queries, and DTOs are exported from a module

## POST-IMPLEMENTATION CHECKLIST (run after every command/handler pair)

Before committing any command + handler:
- [ ] Command/query class does NOT carry user identity (`userId`, `keycloakId`) — handler uses `requireCurrentUser()` instead
- [ ] Command class has `@Validate(XxxValidator)` decorator → grep the command file for `@Validate`
- [ ] `.validator.ts` file exists with Zod schema + `ICommandValidator<T>`
- [ ] Handler uses `getTransactionalRepo(this.xxxRepo)` — never `this.xxxRepo` directly
- [ ] Handler does NOT contain `Result.validationError()` or any `if (x) return Result.failure(...)` validation
- [ ] Controller only injects `CommandBus`/`QueryBus` — no services, no repositories
- [ ] Controller does NOT pass `req.user` fields to commands/queries
- [ ] Every `@DistributedLock` key template `{prop}` matches a real, always-present command property (missing properties fail the command in v7). `@Cache` interpolation is NOT strict — a missing `{prop}` silently interpolates to `''` and can collide cache keys across commands; audit `@Cache` templates manually.

## Controller Pattern (MANDATORY — thin controllers)

Controllers ONLY parse the request and dispatch to command/query bus. No services, no repositories, no business logic. **Do NOT pass user identity (`req.user`, `userId`, `keycloakId`) into commands or queries** — handlers read user context from the execution context store via `requireCurrentUser()`.

```typescript
import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

@Controller('items')
export class ItemsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post()
  async create(@Body() dto: CreateItemDto) {
    return this.commandBus.execute(new CreateItemCommand(dto.name, dto.description));
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.queryBus.execute(new GetItemByIdQuery(id));
  }
}
```

## CQRS Handler Pattern

Every feature is a **Command class + CommandHandler** pair. Controllers are thin — they only
parse the request and dispatch to the command/query bus.

All commands are **transactional by default** (UnitOfWork pattern). Nested commands share one transaction.

```typescript
// Command — business data ONLY, never user identity. @Validate is MANDATORY (without it, .validator.ts is dead code).
// Payload logging is deny-by-default in v7 — opt in via @Log({ logPayload: true, logInclude: [...] })
@Validate(CreateItemValidator)
@DistributedLock('create-item:{name}')
export class CreateItemCommand {
  constructor(public readonly name: string, public readonly description: string) {}
}

// Handler — NEVER validation logic here (use @Validate + .validator.ts)
@CommandHandler(CreateItemCommand)
export class CreateItemHandler implements ICommandHandler<CreateItemCommand> {
  async execute(cmd: CreateItemCommand): Promise<Result<ItemDto>> {
    const { userId } = requireCurrentUser();          // identity from execution context, NEVER from command fields
    const repo = getTransactionalRepo(this.itemRepo); // never this.itemRepo directly
    const item = await repo.save(repo.create({ name: cmd.name, description: cmd.description, createdBy: userId }));
    return Result.success(toDto(item));               // return Result<T>, never throw
  }
}
```

## Pipeline Behavior Chains

**Commands:** `Log (5) → AuthContext (7) → Tracing (10) → InvalidateCache (15) → Performance (20) → FeatureFlag (30) → Validate (40) → Workflow (50) → Cache (60) → DistributedLock (70) → Transactional (80, auto) → Journey (85, runs inside the transaction) → Handler`
**Queries:** `Log (5) → AuthContext (7) → Tracing (10) → Performance (20) → FeatureFlag (30) → Validate (40) → Cache (60) → Handler`

(Behaviors from optional packages — redis, metrics, feature-flags, workflow, journey — appear only when that package's module is imported.)

Pipeline order is **asserted at boot** since v7 (see Pipeline Integrity below).

- `@Log` — global, single structured log per command (duration, result; payload only on explicit opt-in — see `observability-backend.md`)
- **AuthContext** — global, returns `Result.unauthorized()` if no execution context exists. Auto-skipped when `callerType: 'internal'` (set by `runAsService()`)
- **Tracing** — global, OTel span per command/query
- `@FeatureFlag('flag-name')` — Unleash feature flag check before execution (see Feature Flags section below)
- `@Validate(ValidatorClass)` — Zod validation via separate `.validator.ts` class
- `@Cache('key:{prop}', { ttlSeconds: 60 })` — Redis caching with key interpolation
- `@DistributedLock('key:{prop}')` — Redis distributed lock (see Distributed Locks section)
- **Transactional** — automatic for all commands (UnitOfWork). Nested commands share one tx
- `@IsolatedTransaction()` — opt-out: runs in own transaction (audit logs, notifications)
- `@Journey(...)` — journey tracking (`@quanticjs/journey`, command-scoped, order 85, runs inside the transaction)

### Decorator Reference
```typescript
// @Validate — MANDATORY for ALL commands (without it, the .validator.ts is dead code!)
@Validate(CreateItemValidator)
export class CreateItemCommand { ... }

// @Public() on controller endpoint — AuthContextInterceptor sets callerType: 'external'
// For system-initiated dispatch, use runAsService() which sets callerType: 'internal'
// and auto-bypasses AuthContextBehavior — no decorator needed on the command class

// @DistributedLock — efficiency lock (duplicate prevention)
// v7: renewal watchdog is ON BY DEFAULT (every max(1, floor(ttl/3)) seconds) — no option needed
@DistributedLock('create-item:{name}')
export class CreateItemCommand { ... }

// @DistributedLock — correctness lock: MUST pair with optimistic concurrency (version column)
// Consider fencing: true when downstream systems can reject stale writers
@DistributedLock('deduct-inventory:{itemId}', { fencing: true })
export class DeductInventoryCommand { ... }

// @DistributedLock — opt OUT of renewal when TTL must be a hard upper bound on hold time
@DistributedLock('batch:{tenantId}', { lockTtlSeconds: 60, renew: false, tenantScoped: true })
export class BatchImportCommand { ... }

// @Cache — read-heavy queries
@Cache('items:list:{orgId}', { ttlSeconds: 60 })
export class ListItemsQuery { ... }

// @FeatureFlag — see Feature Flags section for naming + fallback rules
@FeatureFlag('release-billing-premium-export', { fallback: 'throw' })
export class ExportReportCommand { ... }

// @IsolatedTransaction — independent commit (audit, notifications)
@IsolatedTransaction()
export class WriteAuditLogCommand { ... }
```

## Distributed Locks (v7 semantics)

`@DistributedLock` is an *efficiency/correctness aid*, not a linearizable guarantee. For financial or uniqueness invariants the database must independently enforce the invariant (optimistic concurrency via version column, unique constraints, or conditional writes carrying the fencing token).

- **Key namespacing:** keys are `lock:<CommandClassName>:<interpolated>` — two command classes can no longer share a lock by using the same template. `tenantScoped: true` inserts `org:<organizationId>:` from the execution context (and fails with `InternalError` when no organizationId is in context — a missing tenant scope never falls back to a global lock).
- **v6→v7 deploy window:** the key format changed from `lock:<key>` to `lock:<Class>:<key>`, so v6 and v7 instances do **not** mutually exclude during a rolling deploy. For lock-critical commands, deploy in a quiet window or drain v6 pods before v7 takes traffic.
- **Strict interpolation:** a `{prop}` placeholder whose value is `null`/`undefined` returns `Result.failure(ErrorType.InternalError)` naming the property — no lock acquired, handler never runs. Audit every key template against the command's properties.
- **Renewal on by default:** the watchdog renews every `max(1, floor(lockTtlSeconds / 3))` seconds (1s floor) via an atomic compare-and-extend Lua script. Opt out with `renew: false` when the TTL must bound hold time. `renewIntervalSeconds` only overrides the interval.
- **Abort on lock loss:** renewal failure aborts an `AbortSignal` in the execution context. `TransactionalBehavior` checks it before commit and rolls back, returning `Result.failure(ErrorType.Conflict)`; the lock behavior backstop converts an inner success to Conflict too. **A handler "success" can come back as Conflict — callers must handle it.** A residual race window remains between signal check and COMMIT — hence the optimistic-concurrency pairing rule above.
- **Fail-closed acquisition:** Redis unavailable → `Result.failure(ErrorType.InternalError)` (default `onRedisUnavailable: 'fail'`), never a thrown ioredis error. `'proceed'` is an explicit per-command opt-out — NOT for correctness locks. HTTP mappers treat `InternalError` as 500.
- **Fencing tokens:** `fencing: true` obtains a monotonically increasing token (`getLockContext()?.fencingToken`) for downstream systems that can reject stale writers (`UPDATE ... WHERE fencing_token < :token`).
- **Acquisition backoff:** polling uses exponential backoff with full jitter (base 50ms, cap 1000ms) — do not "fix" perceived lock slowness by polling manually.
- **Not re-entrant:** a command dispatching a nested command with the same lock key deadlocks until `acquireTimeoutSeconds`, then Conflict. An inner lock loss does not abort the outer transaction.

## Validation Pattern (MANDATORY)

**Two layers — never mix them:**

| Layer | Tool | Where |
|-------|------|-------|
| DTO (controller) | class-validator decorators | `*.dto.ts` |
| Command (pipeline) | Zod + `@Validate(ValidatorClass)` | `*.validator.ts` |

**CRITICAL:** Creating a `.validator.ts` file is NOT enough. The command class MUST have `@Validate(XxxValidator)` decorator or the validator never executes.

**Handlers MUST NOT contain validation logic.** No `if (x < y) return Result.validationError(...)` in handlers. ALL business rule validation belongs in the Zod validator:

```typescript
// ❌ WRONG — validation in handler
async execute(cmd: RegisterUserCommand): Promise<Result<UserDto>> {
  if (calculateAge(cmd.dateOfBirth) < 18) {
    return Result.validationError('Must be at least 18');
  }
  // ...
}

// ✅ CORRECT — validation in .validator.ts via Zod, wired with @Validate on command
import { z } from 'zod';
import { ICommandValidator, validateCommand } from '@quanticjs/core';

export class RegisterUserValidator implements ICommandValidator<RegisterUserCommand> {
  private schema = z.object({
    email: z.string().email(),
    dateOfBirth: z.coerce.date().refine(
      dob => calculateAge(dob) >= 18,
      'Must be at least 18 years old'
    ),
    password: z.string().min(8).max(128),
  });
  validate(cmd: RegisterUserCommand) { return validateCommand(this.schema, cmd); }
}
```

## UnitOfWork — Nested Command Transactions

All commands share an ambient transaction via `AsyncLocalStorage`. Nested commands automatically join the outer transaction — all commit or rollback together.

```typescript
@CommandHandler(OnboardCustomerCommand)
export class OnboardCustomerHandler {
  async execute(cmd: OnboardCustomerCommand): Promise<Result<void>> {
    const user = await this.commandBus.execute(new CreateUserCommand(...));
    if (!user.isSuccess) return user;  // triggers rollback of everything
    const org = await this.commandBus.execute(new CreateOrgCommand(...));
    if (!org.isSuccess) return org;    // triggers rollback of everything (including user)
    return Result.success();           // commits everything atomically
  }
}
```

Use `@IsolatedTransaction()` to opt out (audit logs, notifications that must commit independently). Caveat: isolated commands do NOT join the consumer inbox transaction — their effects can commit even if the inbox row rolls back (at-least-once for that command).

## Result<T> Usage

Handlers return `Result<T>` — never throw for business errors.

Factories: `Result.success(value)`, `Result.failure(ErrorType, 'message')`, and shorthands `Result.notFound()`, `Result.conflict()`, `Result.forbidden()`, `Result.unauthorized()`, `Result.unprocessableEntity()`, plus `Result.validationError()` (ONLY from validators, never handlers).
Consuming: `result.isSuccess` (boolean), `result.value` (undefined if failure), `result.unwrap()` (value or throw on failure), `result.map(item => toDto(item))` (transform value, preserving error state).

The `ErrorType` enum has exactly seven members: `InternalError`, `ValidationError`, `NotFound`, `Conflict`, `Forbidden`, `Unauthorized`, `UnprocessableEntity`. There is no `ServiceUnavailable`. Handlers MUST NOT encode user-facing text in `InternalError` messages — those are masked in production (see `api-patterns.md`); user-facing failures belong in 4xx error types.

## Entity Patterns

All entities extend `BaseEntity` from `@quanticjs/core`:
- `id` (UUID, auto-generated)
- `createdAt` (timestamp)
- `updatedAt` (timestamp)

Tenant-scoped entities extend `TenantBaseEntity` (adds `organizationId`). The `organizationId` is stamped from the execution context on insert — never accept it from request bodies (a mismatch throws; it is ignored on update/remove).

```typescript
import { BaseEntity, TenantBaseEntity, Result } from '@quanticjs/core';
```

## Apache Kafka — Inter-Module Events

The events stack is split into three packages: `@quanticjs/events-core` (envelope, outbox, inbox), `@quanticjs/events-kafka` (Kafka transport — `KafkaEventConsumer`, `CqrsKafkaConsumer`, publisher), and `@quanticjs/events-redis` (Redis Streams — **non-critical eventing only**, see `resilience-ops.md`). One app = one `EVENT_PUBLISHER` transport: `QuanticEventsRedisModule` and `QuanticEventsKafkaModule` MUST NOT be mixed in the same application. Both register the same `EVENT_PUBLISHER` token; mixing them is NOT detected at boot — the last registration silently wins.

- Topic naming: `quantic.events.{category}s` — category is the first segment of `eventType`, **pluralized by the `topic` getter** (e.g. `quantic.events.orders`). The getter supports an optional `routingKey` suffix: `quantic.events.{category}s.{routingKey}`
- `aggregateId` is the Kafka message key — guarantees per-aggregate ordering
- Producers MUST enable **lz4** compression
- Events published via outbox pattern — never directly to Kafka. **Exception:** stateless modules with no database (e.g., `AiGatewayModule`) use `EVENT_PUBLISHER.publish()` directly since there is no transaction to hook an outbox onto

### Event Envelope (wire contract)

Both the outbox path and the direct path produce **structurally identical** envelopes via the shared `publishEnvelope()`:

```typescript
interface EventEnvelope {
  id: string;             // UUID; equals the outbox row id when published via outbox
  type: string;           // eventType, e.g. 'order.created'
  version: number;        // defaults to 1
  aggregateId: string;
  organizationId?: string;
  userId?: string;        // captured at enqueue time
  correlationId?: string;
  causationId?: string;
  timestamp: string;      // ISO-8601
  payload: object;
}
```

Unset optional fields are **absent**, never `''`.

### Publishing — `publishViaOutbox()`

Use `OutboxPublisher.publishViaOutbox(event)` inside a transactional command. It throws without an ambient transaction (unless `allowNonTransactional`). Hand-rolled `OutboxEvent` repository inserts are deprecated — the helper sets the outbox row `id` to the envelope `eventId`, so the consumer inbox dedups outbox-relay duplicates end-to-end.

**HA outbox relay:** the relay claims rows with `FOR UPDATE SKIP LOCKED` (see `database-patterns.md`) — it is multi-replica safe with no leader election. On a publish failure, all later events of the same aggregate within the batch are halted (per-aggregate ordering preserved); rows are processed `createdAt ASC`. After `maxPublishAttempts` (default 5) a row goes `Failed` + outbox DLQ (default destination `quantic.events.dlq`) and the aggregate is released — operators replay `Failed` rows. Config via `QuanticEventsCoreModule.forRoot()`: `pollIntervalMs` (100), `batchSize` (50), `maxPublishAttempts` (5), `dlqDestination`.

**DB-less apps MUST pass `outbox: false`** — `OutboxPublisherService` hard-requires a `DataSource`. Since v7.0.1 `OutboxPublisher` itself is boot-safe with an optional `DataSource`, but `allowNonTransactional` publishing without a `DataSource` throws "requires a TypeORM DataSource" — direct `EVENT_PUBLISHER.publish()` is the only path there.

### Consuming — Result-Aware (`CqrsKafkaConsumer`)

The CQRS pipeline never throws — a discarded failed `Result` is **silent at-most-once delivery**. Therefore:

- `CqrsKafkaConsumer.handleMessage()` MUST inspect `result.isSuccess` for every `commandBus.execute()`. Failures are classified via `errorType` and surfaced as `RetryableProcessingError` / `PermanentProcessingError` — never swallowed.
- **Error classification** (overridable per consumer via `errorClassification` config):

| `errorType` | Classification | Action |
|---|---|---|
| `InternalError` (+ thrown exceptions) | Retryable | Retry with backoff, then DLQ |
| `ValidationError`, `NotFound`, `Conflict`, `Forbidden`, `Unauthorized`, `UnprocessableEntity` | Permanent | DLQ immediately — zero retries |

- Non-`Result` returns are treated as success; a throwing `mapToCommand` takes the retryable path.
- **Multi-command mapping:** commands already executed are NOT rolled back when a later one fails (default path; with the framework inbox enabled, all commands of one message share the inbox transaction and roll back together — except `@IsolatedTransaction` commands); the DLQ record carries `failedCommandIndex`/`totalCommands`.

### Offset Commit & DLQ Safety

- Commit an offset **only** after successful processing OR successful DLQ publish. **NEVER commit when the DLQ publish fails.**
- On DLQ publish failure the consumer applies `dlqFailurePolicy`: `'pause'` (default — pause the topic, retry DLQ every `dlqRetryIntervalMs` = 5000ms, expose `isDlqBlocked()` for readiness) or `'crash'` (exit; K8s restarts and the uncommitted offset is reprocessed). `dlqMaxRetries` (default Infinity) bounds the DLQ-publish retries — when exhausted the consumer stays paused permanently.
- DLQ records always carry `rawValue`/`rawKey` (base64 — deserialization poison is replayable byte-for-byte), `headers`, `deduplicationKey` (`topic:partition:offset`), `errorCategory` (`DESERIALIZATION | PROCESSING | PERMANENT`), `errorType`/`errorMessage`, `commandType`, `failedCommandIndex`, `totalCommands`, `attempts`, `deadLetteredAt`.
- Metrics: `consumedTotal{status}` ∈ `success | retried | dlq | failed` (+ `duplicate` with the inbox enabled) — exactly one terminal-outcome increment per message.
- **Rollout prerequisite:** before upgrading to v7, create every consumed topic's `{topic}.dlq` (or enable auto-create) and alert on `quanticjs_events_dlq_total` — previously-swallowed failures will start dead-lettering.

### Idempotent Consumer Patterns

At-least-once delivery means consumers MUST be idempotent. Two patterns:

**Pattern 1: Framework inbox** (preferred for DB-backed consumers). **Three switches, all required:** (1) `QuanticEventsKafkaModule.forRoot({ ..., inbox: { enabled: true } })` (forwarded to the core module — never call `QuanticEventsCoreModule.forRoot()` separately; that creates a second module entry), (2) `consumer: { inbox: true }` in the same options (or `protected inboxEnabled = true` on the subclass), (3) the consumer constructor injects `@Optional() InboxService` and `@Optional() DataSource` and passes them to `super(config, metrics, inbox, dataSource)`. The base class then wraps `handleMessage()` in one Postgres transaction with `InboxService.tryRecord()` — if any switch is missing it logs a one-time warning and silently stays at-least-once. (`withInbox()` is internal — consumers never call it.) The inbox row and command side effects commit atomically (the consumer opens the transaction; `TransactionalBehavior` joins it via `TransactionContext`); a redelivery executes the handler zero additional times. The framework `processed_events` table uses a composite PK `(eventId, consumerGroup)` — two consumer groups consuming the same event both process it. **Do not hand-roll inbox inserts** — a single-column `event_id` key breaks consumer-group fan-out, and a manual `dataSource.transaction(...)` is a transaction the CQRS pipeline does not join. Inbox retention (default 7 days) must exceed the max redelivery horizon. Non-DB side effects are unprotected — publish events via `publishViaOutbox`, not directly.

**Pattern 2: Natural idempotency** — operations like "set status to X" or "upsert record" are inherently idempotent. No key table needed, but the consumer must produce the same result on duplicate delivery.

### Outbox Table Cleanup

The `OutboxPublisherService` MUST delete published events to prevent unbounded table growth. A scheduled cleanup job runs daily at 03:00 (server-local time — `@Cron('0 3 * * *')` with no timeZone; UTC only if the container runs TZ=UTC), deleting events with `status = 'Published'` and `published_at` older than 7 days. Deletes are batched in chunks of 1000 rows with 100ms pause between batches.

### Retry and Dead-Letter Policy

- **Retryable failures only:** max 5 retries (configurable via `maxRetries`/`maxBackoffMs`) with exponential backoff + jitter (`min(1s × 2^attempt + random(0,1000ms), 30s)`)
- **Permanent failures:** straight to DLQ with zero retries (see classification table above)
- **Dead-letter topic:** `{topic}.dlq` (e.g., `quantic.events.orders.dlq`) with 30-day retention
- Failed events are never silently dropped — retry or dead-letter

### Consumer Configuration

- The base class pins `session.timeout.ms=45s`, `heartbeat.interval.ms=5s`, `max.poll.interval.ms=5min` (not configurable)
- Long-running handlers (>30s) MUST call `this.heartbeat()` periodically; the framework heartbeats at least every 3s **during retry-backoff sleeps** (with defaults, a single message can hold a partition ~35-40s of backoff plus six handler executions)
- `lagProbeIntervalMs` (default 30000, 0 disables) drives the `quanticjs_events_consumer_lag` and `quanticjs_events_last_processed_timestamp_seconds` metrics
- `KafkaEventsModuleOptions` also supports `ssl`, `sasl` (scram-sha-512), and `consumer: KafkaConsumerOptions` with per-subclass `protected` field overrides

## NestJS Module Patterns — Singletons and Lifecycle

### .forRoot() Modules — Import ONCE in app.module.ts

Modules with `.forRoot()` (ScheduleModule, LoggerModule, BullModule, etc.) MUST be imported
**exactly once** in `app.module.ts`. Feature modules import the regular module (no `.forRoot()`). Calling any `forRoot()` twice is unsupported.

```typescript
// ❌ WRONG — .forRoot() in every feature module
@Module({ imports: [ScheduleModule.forRoot()] })
export class ActivityModule {}

@Module({ imports: [ScheduleModule.forRoot()] })
export class BillingModule {}

// ✅ CORRECT — .forRoot() once in app.module.ts
@Module({
  imports: [
    ScheduleModule.forRoot(),        // once here
    LoggerModule.forRoot(pinoConfig), // once here
    BullModule.forRoot({ redis }),    // once here
    ActivityModule,
    BillingModule,
  ],
})
export class AppModule {}

// Feature modules just use the schedule decorators — no .forRoot() needed
@Module({ providers: [ActivityCleanupService] })
export class ActivityModule {}
```

This applies to `QuanticCoreModule` (exactly one entry; a second fails boot via the pipeline-integrity check — default `mode: 'throw'`; `'warn'` downgrades to an error log), `ScheduleModule`, `LoggerModule`, `BullModule`, `QuanticEventsKafkaModule`, `QuanticFeatureFlagsModule` (NOT `UnleashModule.forRoot()` directly — see Feature Flags), `ThrottlerModule`, and `QuanticHealthModule`; per-module `.forRoot()` options live in each package's `ModuleOptions` types and docs.

### Pipeline Integrity — Verified at Boot (v7)

`QuanticCoreModule.forRoot({ integrity: { mode } })` defaults to `'throw'`: **boot fails** on a dual `CqrsModule` entry, an unpatched bus, or zero discovered behaviors. `mode: 'warn'` is a temporary unblock only. Integrity options also include `minCommandBehaviors`/`minQueryBehaviors` (default 1 each). A one-line boot summary reports verified behavior counts and bus-patch status; use `describePipeline(app)` to inspect the actual chain.

**Lifecycle-hook dispatches traverse the pipeline.** Buses are patched at construction, so a `commandBus.execute(...)` in `onModuleInit`/`onApplicationBootstrap` hits `AuthContextBehavior` and returns `Result.unauthorized('No execution context')` unless wrapped in `runAsService()`. Always wrap system-initiated dispatch (lifecycle hooks, cron jobs, consumers not using `KafkaEventConsumer`'s auto-wrap) in `runAsService()`.

### CqrsModule — NEVER Import in Feature Modules

`CqrsModule.forRoot()` is registered once in `QuanticCoreModule` with `global: true`. This means `CommandBus` and `QueryBus` are available everywhere — feature modules do NOT need to import `CqrsModule`.

Importing `CqrsModule` in a feature module creates a **second NestJS module entry** with its own `CommandBus` instance. `QuanticCommandBus` only patches the `CommandBus` from the dynamic `.forRoot()` entry — the second instance is **unpatched**, so commands dispatched through it bypass the entire pipeline (Log, Validate, Transactional, AuthContext, DistributedLock, etc.).

In v6 this failed silently; **since v7 it fails boot** (integrity mode `'throw'` — see above).

```typescript
// ❌ WRONG — creates a duplicate CommandBus that bypasses the CQRS pipeline (v7: boot failure)
@Module({
  imports: [CqrsModule, TypeOrmModule.forFeature([Item])],
  // ...
})
export class ItemModule {}

// ✅ CORRECT — CqrsModule is already global via QuanticCoreModule, no import needed
@Module({
  imports: [TypeOrmModule.forFeature([Item])],
  // ...
})
export class ItemModule {}
```

**How to detect:** boot fails with a named integrity error in v7. To pre-check: `grep -r "CqrsModule" src/ --include="*.module.ts"`, or inspect `describePipeline(app)`.

### Behavior Registration Hygiene

- Each pipeline behavior class must be provided by **exactly one module**. `BehaviorRegistry` dedups by constructor identity with a warning; set `failOnDuplicate: true` on `QuanticCoreModule.forRoot()` in production apps to turn duplicates into boot failures.
- Custom `@Behavior()` orders must be **distinct values with a gap ≥ 5** from framework orders (Log 5, AuthContext 7, Tracing 10, InvalidateCache 15, Performance 20, FeatureFlag 30, Validate 40, Workflow 50, Cache 60, DistributedLock 70, Transactional 80, Journey 85). Equal-order behaviors tie-break alphabetically — never rely on that.
- To override a framework behavior, use a NestJS provider override (`{ provide: CacheBehavior, useClass: MyCacheBehavior }`) — never a second registration.
- After upgrades, grep boot logs for `"Duplicate behavior registration"` and `"Behavior order collision"`.

### Lifecycle Hooks — Setup vs. Async Work

`onModuleInit()` = synchronous setup (connect, subscribe, register handlers); `onApplicationBootstrap()` = starting async work (polling loops, listeners). Two rules:

- **Do NOT re-implement base-class lifecycle.** For Kafka consumers the base class owns the lifecycle (subscribe in `onModuleInit`, start consuming in `onApplicationBootstrap`, disconnect in `onModuleDestroy`); subclasses only declare `topic`/`groupId`/`handleMessage` (optionally `shouldHandle(event)`) — `handleMessage` is already wrapped in `runAsService()`.
- **NEVER start consuming in `onModuleInit()`** — processing would begin before `app.listen()` and dependencies may not be ready. Any command dispatched from your own lifecycle hooks needs `runAsService()` (see Pipeline Integrity above).

### Graceful Shutdown (ADR-017)

Two-phase shutdown on SIGTERM: a Kubernetes preStop hook (`sleep 5`) lets the LB deregister the pod, then readiness flips to 503 (`QuanticHealthModule`), then `GracefulShutdownService` drains in-flight work and closes DB/Redis.

**Required in `app.module.ts`:**

```typescript
QuanticHealthModule.forRoot({
  transport: { type: 'controller' },
  shutdownAware: true,
  shutdownDelayMs: 0, // preStop hook covers the LB delay; 5000 only without preStop
}),
```

**Required in `main.ts`:**

```typescript
app.enableShutdownHooks();
app.setGlobalPrefix('api', { exclude: ['auth/*path', 'health/*path'] });
```

Full shutdown sequence, timings, and probe alignment: see `resilience-ops.md`.

### Redis Connection — Caching and Locks Only

Redis (`REDIS_CLIENT`) is used for caching and distributed locks only. Critical event-driven communication uses Apache Kafka via `KafkaEventConsumer` from `@quanticjs/events-kafka`. This separation means a Redis outage does not affect event delivery, and vice versa. (`@quanticjs/events-redis` exists for non-critical eventing only and cannot be mixed with the Kafka transport in one app — see `resilience-ops.md` for its mandatory reliability options.)

```typescript
// ✅ CORRECT — KafkaEventConsumer with DI-injected config from QuanticEventsKafkaModule.forRoot()
@Injectable()
export class EventConsumer extends KafkaEventConsumer {
  readonly topic = 'quantic.events.orders';
  readonly groupId = 'notification-consumers';

  constructor(
    @Inject(KAFKA_OPTIONS) config: KafkaEventsModuleOptions,
    @Inject('KAFKA_METRICS') metrics: KafkaEventMetrics,
  ) {
    super(config, metrics);
  }

  async handleMessage(event: KafkaEvent): Promise<void> {
    // process event
  }
}
```

### Module Exports — Only Export What You Provide

A module can only export providers it declares. **Never re-export a `@Global()` module** (e.g. `RedisModule` from a wrapper, `UnleashModule` from `QuanticFeatureFlagsModule`-style wrappers): re-exporting creates a duplicate module entry with separate provider instances — a second ioredis connection, a behavior executing twice. Forwarding re-exports in general are an anti-pattern; export providers, not modules.

```typescript
// ❌ WRONG — KafkaEventPublisher not declared as provider
@Module({
  providers: [EventStreamService],
  exports: [EventStreamService, KafkaEventPublisher],  // 🔥 KafkaEventPublisher not provided
})
export class EventBusModule {}

// ❌ WRONG — re-exporting a @Global() module duplicates its providers
@Module({
  imports: [RedisModule],
  exports: [RedisModule],  // 🔥 second ioredis connection downstream
})
export class InfraModule {}

// ✅ CORRECT — only export declared providers
@Module({
  providers: [EventStreamService],
  exports: [EventStreamService],
})
export class EventBusModule {}
```

## Feature Flags

Uses `@FeatureFlag()` decorator with Unleash. Apps MUST import `QuanticFeatureFlagsModule.forRoot()` — never `UnleashModule.forRoot()` directly (since v7, `UnleashModule` no longer provides `FeatureFlagBehavior`; importing it directly makes every `@FeatureFlag` decorator silently inert).

Three categories:

| Category | Naming | Lifetime | Default fallback |
|---|---|---|---|
| **Release** | `release-{module}-{feature}` | Remove within 30 days of full rollout | `throw` (Forbidden) |
| **Kill switch** | `kill-{module}-{feature}` | Permanent — stays in code | `throw` (Forbidden) |
| **Experiment** | `experiment-{module}-{feature}` | Remove within 90 days | `default` (control variant) |

**Fallback strategies** when a flag is disabled:

| Strategy | Behavior |
|---|---|
| `throw` (default) | Returns `Result.failure(Forbidden, 'Feature "{flag}" is currently disabled')` |
| `skip` | Returns `Result.success(undefined)` — for optional features |
| `default` | Returns `Result.success(defaultValue)` — for experiments |

```typescript
@FeatureFlag('release-billing-invoices')                                    // throw if disabled
@FeatureFlag('kill-payments-processing')                                    // throw if disabled
@FeatureFlag('experiment-scoring-v2', { fallback: 'default', defaultValue: oldResult })
@FeatureFlag('release-notifications-email', { fallback: 'skip' })           // silently skip
```

**Degradation is fail-closed:** when Unleash is unreachable (and no bootstrap/backup exists), `isEnabled()` returns `false` for every flag — with the default `'throw'` fallback, a provider outage disables every guarded feature. In production, boot **fails** on the insecure default token or a localhost URL. See `resilience-ops.md` → Feature-Flag Degradation for the full contract (error listeners, `bootstrap`/`backupPath`, per-flag fallback choice).

## NEVER

- **NEVER** pass user identity (`userId`, `keycloakId`, `req.user`) as command/query constructor parameters — handlers read identity from the execution context via `requireCurrentUser()` / `getCurrentUser()`
- **NEVER** inject services or repositories into controllers — dispatch to the bus only
- **NEVER** put business logic in controllers
- **NEVER** put validation logic in handlers — use `@Validate` + `.validator.ts`
- **NEVER** use Joi, Yup, or other validation libraries — class-validator for DTOs, Zod for commands
- **NEVER** create a `.validator.ts` file without `@Validate(XxxValidator)` on the command class — it's dead code
- **NEVER** throw `HttpException` from handlers — return `Result<T>`
- **NEVER** use `Result.validationError()` in handlers
- **NEVER** ignore Result values from nested commands
- **NEVER** discard the `Result` returned by `commandBus.execute()` in event consumers — the pipeline never throws; a discarded failure is silent at-most-once delivery
- **NEVER** commit a Kafka offset whose message was neither processed successfully nor durably dead-lettered
- **NEVER** call `.unwrap()` inside handlers
- **NEVER** manually manage transactions — use `getTransactionalRepo()`
- **NEVER** dispatch commands/queries from lifecycle hooks, cron jobs, or other system-initiated code without `runAsService()` — `AuthContextBehavior` returns `Result.unauthorized('No execution context')`
- **NEVER** start Kafka consumers in `onModuleInit()` — the base class handles lifecycle; subclasses declare `topic`/`groupId`/`handleMessage` only
- **NEVER** publish events before the transaction commits
- **NEVER** hand-roll outbox or inbox table inserts — use `publishViaOutbox()` and the framework inbox (opt-in via module options; `withInbox()` is internal)
- **NEVER** silently drop failed events — retry with backoff or dead-letter to `{topic}.dlq`
- **NEVER** use `NestJS EventEmitter` for inter-module events
- **NEVER** publish events directly to Kafka from handlers — use the outbox pattern (exception: stateless modules with no DB like `AiGatewayModule` use `EVENT_PUBLISHER.publish()` directly)
- **NEVER** mix `QuanticEventsRedisModule` and `QuanticEventsKafkaModule` in the same application — one app, one event transport
- **NEVER** use the v6 `static logExclude` class property on commands — it is dead code; use `@Log({ logPayload: true, logExclude: [...] })` (see `observability-backend.md`)
- **NEVER** use global singletons for shared business state across modules — use Redis or the database
- **NEVER** import `.forRoot()` modules in feature modules
- **NEVER** import `CqrsModule` in feature modules — it's already global via `QuanticCoreModule.forRoot()`. A static import creates a second `CommandBus` instance that bypasses the entire CQRS pipeline; since v7 this **fails boot** (integrity mode `'throw'`)
- **NEVER** re-export a `@Global()` module from another module — duplicate provider instances (second Redis connection, double-executing behaviors)
- **NEVER** register the same pipeline behavior from two modules — one behavior class, one owning module; override via provider override
- **NEVER** import `UnleashModule.forRoot()` directly — use `QuanticFeatureFlagsModule.forRoot()` or `@FeatureFlag` decorators are silently inert
- **NEVER** use feature flags on infrastructure code (migrations, middleware, module config) — use env vars
- **NEVER** nest multiple `@FeatureFlag` decorators on one handler — one handler, one flag
- **NEVER** use flags as permanent configuration — if always needs on/off, use env vars
- **NEVER** remove `app.enableShutdownHooks()` from `main.ts` — without it, `onModuleDestroy` never fires on SIGTERM
- **NEVER** omit `QuanticHealthModule.forRoot()` from `app.module.ts` — readiness won't flip to 503 on shutdown
- **NEVER** use `redis.disconnect()` in shutdown logic — use `redis.quit()` which flushes pending commands first
