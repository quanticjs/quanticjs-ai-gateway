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
- [ ] Command class has `@Validate(XxxValidator)` decorator → grep the command file for `@Validate`
- [ ] `.validator.ts` file exists with Zod schema + `ICommandValidator<T>`
- [ ] Handler uses `getTransactionalRepo(this.xxxRepo)` — never `this.xxxRepo` directly
- [ ] Handler does NOT contain `Result.validationError()` or any `if (x) return Result.failure(...)` validation
- [ ] Controller only injects `CommandBus`/`QueryBus` — no services, no repositories

## Controller Pattern (MANDATORY — thin controllers)

Controllers ONLY parse the request and dispatch to command/query bus. No services, no repositories, no business logic.

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
import { Validate, DistributedLock, getTransactionalRepo, Result } from '@nestjs-cqrs/quanticjs';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

// Command class — MUST have @Validate decorator (without it, .validator.ts is dead code)
@Validate(CreateItemValidator)           // ← MANDATORY — this wires the validator
@DistributedLock('create-item:{name}')
export class CreateItemCommand {
  static readonly logExclude = ['largeField']; // optional: exclude fields from @Log output
  constructor(public readonly name: string, public readonly description: string) {}
}

// Handler — uses getTransactionalRepo for UnitOfWork participation
// ⚠️ NEVER put validation logic in handlers — use @Validate + .validator.ts
@CommandHandler(CreateItemCommand)
export class CreateItemHandler implements ICommandHandler<CreateItemCommand> {
  constructor(@InjectRepository(Item) private readonly itemRepo: Repository<Item>) {}
  async execute(command: CreateItemCommand): Promise<Result<ItemDto>> {
    const itemRepo = getTransactionalRepo(this.itemRepo);
    const item = itemRepo.create({ name: command.name, description: command.description });
    await itemRepo.save(item);
    return Result.success(toDto(item));
  }
}
```

## Pipeline Behavior Chains

**Commands:** `Log (global) → FeatureFlag → Validate → Cache → DistributedLock → Transactional (auto) → Handler`
**Queries:** `Log (global) → FeatureFlag → Validate → Cache → Handler`

- `@Log` — global, single structured log per command (payload, duration, result, auto-truncated)
- `@FeatureFlag('flag-name')` — Unleash feature flag check before execution (see Feature Flags section below)
- `@Validate(ValidatorClass)` — Zod validation via separate `.validator.ts` class
- `@Cache('key:{prop}', { ttlSeconds: 60 })` — Redis caching with key interpolation
- `@DistributedLock('key:{prop}')` — Redis distributed lock (efficiency guarantee only; for correctness — e.g. payments, inventory — pair with optimistic concurrency via version column)
- **Transactional** — automatic for all commands (UnitOfWork). Nested commands share one tx
- `@IsolatedTransaction()` — opt-out: runs in own transaction (audit logs, notifications)

### Decorator Reference
```typescript
// @Validate — MANDATORY for ALL commands (without it, the .validator.ts is dead code!)
@Validate(CreateItemValidator)
export class CreateItemCommand { ... }

// @DistributedLock — efficiency lock (duplicate prevention)
@DistributedLock('create-item:{name}')
export class CreateItemCommand { ... }

// @DistributedLock — correctness lock: MUST pair with optimistic concurrency (version column)
@DistributedLock('deduct-inventory:{itemId}')
export class DeductInventoryCommand { ... }

// @DistributedLock — long-running: use renewIntervalSeconds to extend TTL
@DistributedLock('batch:{tenantId}', { lockTtlSeconds: 60, renewIntervalSeconds: 20 })
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
import { ICommandValidator, validateCommand } from '@nestjs-cqrs/quanticjs';

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

Use `@IsolatedTransaction()` to opt out (audit logs, notifications that must commit independently).

## Result<T> Usage

Handlers return `Result<T>` — never throw for business errors.

```typescript
// Creating results
Result.success(value)                              // happy path
Result.failure(ErrorType.NotFound, 'message')      // typed error
Result.notFound('message')                         // shorthand
Result.conflict('message')                         // shorthand
Result.forbidden('message')                        // shorthand
Result.unauthorized('message')                     // shorthand
Result.unprocessableEntity('message')              // shorthand
Result.validationError('message')                  // ONLY from validators, never handlers

// Using results
result.isSuccess                                   // boolean check
result.value                                       // access value (undefined if failure)
result.unwrap()                                    // get value or throw if failure
result.map(item => toDto(item))                    // transform value, preserving error state
```

## Entity Patterns

All entities extend `BaseEntity` from `@nestjs-cqrs/quanticjs`:
- `id` (UUID, auto-generated)
- `createdAt` (timestamp)
- `updatedAt` (timestamp)

Tenant-scoped entities extend `TenantBaseEntity` (adds `organizationId`).

```typescript
import { BaseEntity, TenantBaseEntity, Result } from '@nestjs-cqrs/quanticjs';
```

## Apache Kafka — Inter-Module Events

- Use `KafkaEventConsumer` base class for consumers (from `@quanticjs/events`)
- Topic naming: `quantic.events.<category>` (e.g., `quantic.events.orders`)
- `aggregateId` is the Kafka message key — guarantees per-aggregate ordering
- Producers MUST enable **lz4** compression
- `onModuleInit()` for setup; `onApplicationBootstrap()` to start consuming
- Events published via outbox pattern — never directly to Kafka. **Exception:** stateless modules with no database (e.g., `AiGatewayModule`) use `EVENT_PUBLISHER.publish()` directly since there is no transaction to hook an outbox onto

### Idempotent Consumer Patterns

At-least-once delivery means consumers MUST be idempotent. Two patterns:

**Pattern 1: Idempotency key table** (preferred for DB-backed consumers) — `INSERT ... ON CONFLICT` in the same transaction as the business operation:

```typescript
await dataSource.transaction(async (manager) => {
  const result = await manager.query(
    `INSERT INTO shared.processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [event.id],
  );
  if (result[1] === 0) return; // already processed
  // ... process event within this transaction ...
});
```

**Pattern 2: Natural idempotency** — operations like "set status to X" or "upsert record" are inherently idempotent. No key table needed, but the consumer must produce the same result on duplicate delivery.

### Outbox Table Cleanup

The `OutboxPublisherService` MUST delete published events to prevent unbounded table growth. A scheduled cleanup job runs daily at 03:00 UTC, deleting events with `status = 'Published'` and `published_at` older than 7 days. Deletes are batched in chunks of 1000 rows with 100ms pause between batches.

### Retry and Dead-Letter Policy

- **Max retries:** 5 with exponential backoff + jitter (`min(1s × 2^attempt + random(0,1000ms), 30s)`)
- **Dead-letter topic:** `{topic}.dlq` (e.g., `quantic.events.orders.dlq`) with 30-day retention
- Failed events are never silently dropped — retry or dead-letter

### Consumer Configuration

- `sessionTimeout`: 45s — accommodates I/O-heavy consumers
- `heartbeatInterval`: 5s — must be < sessionTimeout/3
- Long-running handlers (>30s) MUST call `this.heartbeat()` periodically

## NestJS Module Patterns — Singletons and Lifecycle

### .forRoot() Modules — Import ONCE in app.module.ts

Modules with `.forRoot()` (ScheduleModule, LoggerModule, BullModule, etc.) MUST be imported
**exactly once** in `app.module.ts`. Feature modules import the regular module (no `.forRoot()`).

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

**Common .forRoot() modules that must be in app.module.ts only:**
- `ScheduleModule.forRoot()` — @nestjs/schedule
- `LoggerModule.forRoot()` — nestjs-pino
- `BullModule.forRoot()` — @nestjs/bull
- `QuanticEventsKafkaModule.forRoot()` — @quanticjs/events-kafka
- `ThrottlerModule.forRoot()` — @nestjs/throttler
- `QuanticHealthModule.forRoot()` — @quanticjs/health (shutdown-aware readiness)

### Lifecycle Hooks — Setup vs. Async Work

**`onModuleInit()`** — for synchronous setup (create consumer groups, register handlers).
**`onApplicationBootstrap()`** — for starting async work (polling loops, listeners).

```typescript
// ❌ WRONG — starting consumer in onModuleInit prevents app.listen()
@Injectable()
export class EventConsumer extends KafkaEventConsumer implements OnModuleInit {
  async onModuleInit() {
    await this.createConsumer();
    this.startConsuming();  // 🔥 starts before app is ready
  }
}

// ✅ CORRECT — setup in onModuleInit, consuming in onApplicationBootstrap
@Injectable()
export class EventConsumer extends KafkaEventConsumer implements OnModuleInit, OnApplicationBootstrap {
  async onModuleInit() {
    // Synchronous setup only — create consumer, subscribe to topic
    await this.createConsumer();
  }

  async onApplicationBootstrap() {
    // App is fully started — safe to begin consuming
    this.startConsuming();  // non-blocking — begins processing messages
  }
}
```

**Why this matters:** Starting Kafka consumers in `onModuleInit()` means message processing begins before the app reaches `app.listen()`. Dependencies may not be ready.

### Graceful Shutdown (ADR-017)

Two-phase shutdown on SIGTERM, preceded by a Kubernetes preStop hook:

**preStop hook** (`sleep 5`) runs at the K8s level before SIGTERM reaches the application, giving the load balancer time to deregister the pod.

**Phase 1** is handled by `QuanticHealthModule` — readiness returns 503 immediately. No additional `shutdownDelayMs` needed since preStop already waited.

**Phase 2** is handled by `GracefulShutdownService` — drains in-flight work, closes DB, quits Redis.

**Required in `app.module.ts`:**

```typescript
QuanticHealthModule.forRoot({
  transport: { type: 'controller' },
  shutdownAware: true,
  shutdownDelayMs: 5_000,
}),
```

**Required in `main.ts`:**

```typescript
app.enableShutdownHooks();
app.setGlobalPrefix('api', { exclude: ['auth/*path', 'health/*path'] });
```

**Custom drain logic** — if the service has Bull queues, WebSocket servers, or other long-lived resources, extend `GracefulShutdownService`:

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
    await this.queueWorker.close();
  }
}
```

**Kubernetes alignment:** `terminationGracePeriodSeconds >= shutdownDelayMs + 30s (drain) + 5s (buffer)`. Default: 45s.

### Redis Connection — Caching and Locks Only

Redis (`REDIS_CLIENT`) is used for caching and distributed locks only. Event-driven communication uses Apache Kafka via `KafkaEventConsumer` from `@quanticjs/events`. This separation means a Redis outage does not affect event delivery, and vice versa.

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

A module can only export providers it declares or imports. Exporting a class that isn't a provider in the module causes a runtime error.

```typescript
// ❌ WRONG — KafkaEventPublisher not declared as provider
@Module({
  providers: [EventStreamService],
  exports: [EventStreamService, KafkaEventPublisher],  // 🔥 KafkaEventPublisher not provided
})
export class EventBusModule {}

// ✅ CORRECT — only export what's in providers (or re-exported modules)
@Module({
  providers: [EventStreamService],
  exports: [EventStreamService],
})
export class EventBusModule {}
```

## Feature Flags

Uses `@FeatureFlag()` decorator with Unleash. Three categories:

| Category | Naming | Lifetime | Default fallback |
|---|---|---|---|
| **Release** | `release-{module}-{feature}` | Remove within 30 days of full rollout | `throw` (Forbidden) |
| **Kill switch** | `kill-{module}-{feature}` | Permanent — stays in code | `throw` (Forbidden) |
| **Experiment** | `experiment-{module}-{feature}` | Remove within 90 days | `default` (control variant) |

**Fallback strategies** when a flag is disabled:

| Strategy | Behavior |
|---|---|
| `throw` (default) | Returns `Result.forbidden('Feature disabled: {flag}')` |
| `skip` | Returns `Result.success(undefined)` — for optional features |
| `default` | Returns `Result.success(defaultValue)` — for experiments |

```typescript
@FeatureFlag('release-billing-invoices')                                    // throw if disabled
@FeatureFlag('kill-payments-processing')                                    // throw if disabled
@FeatureFlag('experiment-scoring-v2', { fallback: 'default', defaultValue: oldResult })
@FeatureFlag('release-notifications-email', { fallback: 'skip' })           // silently skip
```

**Graceful degradation:** If `UNLEASH_URL` is not set, all flags pass (features enabled by default). Local dev and tests work without Unleash.

## NEVER

- **NEVER** inject services or repositories into controllers — dispatch to the bus only
- **NEVER** put business logic in controllers
- **NEVER** put validation logic in handlers — use `@Validate` + `.validator.ts`
- **NEVER** use Joi, Yup, or other validation libraries — class-validator for DTOs, Zod for commands
- **NEVER** create a `.validator.ts` file without `@Validate(XxxValidator)` on the command class — it's dead code
- **NEVER** throw `HttpException` from handlers — return `Result<T>`
- **NEVER** use `Result.validationError()` in handlers
- **NEVER** ignore Result values from nested commands
- **NEVER** call `.unwrap()` inside handlers
- **NEVER** manually manage transactions — use `getTransactionalRepo()`
- **NEVER** start Kafka consumers in `onModuleInit()` — use `onApplicationBootstrap()`
- **NEVER** publish events before the transaction commits
- **NEVER** silently drop failed events — retry with backoff or dead-letter to `{topic}.dlq`
- **NEVER** use `NestJS EventEmitter` for inter-module events
- **NEVER** publish events directly to Kafka from handlers — use the outbox pattern (exception: stateless modules with no DB like `AiGatewayModule` use `EVENT_PUBLISHER.publish()` directly)
- **NEVER** use global singletons for shared business state across modules — use Redis or the database
- **NEVER** import `.forRoot()` modules in feature modules
- **NEVER** use feature flags on infrastructure code (migrations, middleware, module config) — use env vars
- **NEVER** nest multiple `@FeatureFlag` decorators on one handler — one handler, one flag
- **NEVER** use flags as permanent configuration — if always needs on/off, use env vars
- **NEVER** remove `app.enableShutdownHooks()` from `main.ts` — without it, `onModuleDestroy` never fires on SIGTERM
- **NEVER** omit `QuanticHealthModule.forRoot()` from `app.module.ts` — readiness won't flip to 503 on shutdown
- **NEVER** use `redis.disconnect()` in shutdown logic — use `redis.quit()` which flushes pending commands first
