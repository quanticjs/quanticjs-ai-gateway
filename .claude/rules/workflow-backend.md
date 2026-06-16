---
globs: "src/**/*.ts"
---

# Workflow Backend — QuanticFlow Is the Engine

QuanticFlow is a **standalone workflow engine** running as its own service. Your application connects to it via a **hybrid pattern**: HTTP for `startProcess` (synchronous) and read-only queries, Kafka for all other mutations. QuanticFlow publishes events and command results back via Kafka. **Application code defines workflow definitions and reacts to workflow events — it never embeds or reimplements the engine.**

## Architecture

```
Your App (NestJS)                          QuanticFlow (standalone)
┌──────────────────┐     HTTP POST         ┌────────────────────┐
│ WorkflowClient   │ ──(start only)────>   │ REST API           │
│ (circuit breaker)│                       │ /api/workflows     │
│                  │     HTTP GET           │ /api/tasks         │
│                  │ ──(queries)────────>   └────────┬───────────┘
│                  │                                 │
│                  │     Kafka "quantic.commands"    │
│                  │ ──(mutations)──────>   ┌────────▼───────────┐
└──────────────────┘                       │ Workflow Engine     │
                                           │ (state machine,     │
                                           │  task routing,      │
                                           │  process eval)      │
                                           └────────┬───────────┘
                                                    │ Outbox → Kafka
Your App                                   ┌────────▼───────────┐
┌──────────────────┐     Kafka consumer    │ quantic.events.*    │
│ Event Consumer   │ <─────────────────    │ quantic.commands.   │
│ (per-definition) │                       │   results.<app>     │
│ Result Consumer  │ <─────────────────    └────────────────────┘
└──────────────────┘
```

- App → QuanticFlow: HTTP only for `startProcess` (needs `instanceId` synchronously) and read-only queries (timeline, task list, task detail); ALL other mutations (signal, abort, suspend, resume, claim, unclaim, executeAction, reassign, setVariables) go as Kafka commands on `quantic.commands`.
- QuanticFlow → App: workflow state-change events on per-definition `quantic.events.*` topics; command ack/nack results on the per-app `quantic.commands.results.<sourceApp>` topic.
- This hybrid split applies to **app-initiated** mutations from your own `WorkflowClientService`; the framework's `@quanticjs/workflow-quanticflow` adapter itself signals/aborts over HTTP for `@Workflow`-decorated commands and service-task completion signals — that internal path is exempt.
- Path examples in this file are illustrative; the framework adapter (`QuanticFlowClient`) talks to QuanticFlow at `POST /workflow/instances` (start), `/workflow/instances/:id/signal|abort|variables`, and `/workflow/tasks...` — that client is the authoritative contract.

## Module Registration — QuanticEventsKafkaModule

`QuanticEventsKafkaModule.forRoot()` provides `KafkaEventPublisher` (+ `EVENT_PUBLISHER`), `KAFKA_OPTIONS`, `KAFKA_METRICS`, and the `KafkaConsumerStatusRegistry` (also bound to `KAFKA_CONSUMER_STATUS` for health auto-detection). It transitively registers `QuanticEventsCoreModule` (outbox relay + cleanup, opt-in inbox via `inbox: { enabled: true }`) — the outbox is ON by default and requires a TypeORM `DataSource` and `ScheduleModule.forRoot()`; DB-less apps MUST pass `outbox: false`. Import once in `app.module.ts`:

```typescript
import { QuanticEventsKafkaModule } from '@quanticjs/events-kafka';

@Module({
  imports: [
    QuanticEventsKafkaModule.forRoot({
      brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
      clientId: process.env.APP_NAME ?? 'your-app',
    }),
  ],
})
export class AppModule {}
```

## WorkflowClientService — Hybrid HTTP + Kafka Adapter

`startProcess` stays HTTP (needs synchronous `instanceId`). Read-only queries stay HTTP. All other mutations publish Kafka commands to `quantic.commands` and return a `commandId` (fire-and-forget). Results arrive asynchronously on `quantic.commands.results.<sourceApp>`.

```typescript
import { Injectable } from '@nestjs/common';
import { createCircuitBreaker } from '@quanticjs/core';
import { DomainEvent } from '@quanticjs/events-core';
import { KafkaEventPublisher } from '@quanticjs/events-kafka';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'crypto';

class KafkaCommand extends DomainEvent {
  private readonly _topic: string;
  constructor(topic: string, aggregateId: string, payload: Record<string, unknown>, correlationId?: string) {
    super('command', aggregateId, payload, undefined, undefined, correlationId);
    this._topic = topic;
  }
  override get topic(): string { return this._topic; }
}

interface CommandOpts {
  userId: string;
  userRoles: string[];
  data?: Record<string, unknown>;
}

@Injectable()
export class WorkflowClientService {
  private readonly baseUrl = process.env.QUANTICFLOW_URL!;
  private readonly breaker = createCircuitBreaker({ maxRetries: 2, consecutiveFailures: 5, halfOpenAfterMs: 30_000 });

  constructor(
    @InjectPinoLogger(WorkflowClientService.name) private readonly logger: PinoLogger,
    private readonly kafkaPublisher: KafkaEventPublisher,
  ) {}

  // ─── HTTP (synchronous) ───────────────────────────────────────────
  // correlationId is the idempotency key — QuanticFlow dedups instance starts on it.
  // Derive it from business identity (e.g. orderId), never from volatile fields.
  async startProcess(
    definitionId: string,
    variables: Record<string, unknown>,
    correlationId: string,
  ): Promise<{ instanceId: string }> {
    return this.breaker.execute(() =>
      this.post(`/api/workflows/${definitionId}/start`, { variables, correlationId }));
  }

  async getProcessTimeline(instanceId: string): Promise<unknown> {
    return this.breaker.execute(() => this.get(`/api/workflows/instances/${instanceId}/timeline`));
  }

  // ─── Kafka commands (fire-and-forget, returns commandId) ──────────
  async signalProcess(instanceId: string, signal: string, opts: CommandOpts): Promise<string> {
    return this.publishCommand('signalprocess', opts.userId, opts.userRoles, { instanceId, signal, data: opts.data });
  }

  async claimTask(taskId: string, opts: Omit<CommandOpts, 'data'>): Promise<string> {
    return this.publishCommand('claimtask', opts.userId, opts.userRoles, { taskId });
  }

  async executeAction(taskId: string, actionName: string, opts: CommandOpts): Promise<string> {
    return this.publishCommand('executeaction', opts.userId, opts.userRoles, { taskId, actionName, data: opts.data });
  }

  // Also available: abortProcess, suspendProcess, resumeProcess, setVariables, unclaimTask, reassignTask

  private async publishCommand(
    commandType: string, userId: string, userRoles: string[], payload: Record<string, unknown>,
  ): Promise<string> {
    const commandId = randomUUID();
    const correlationId = randomUUID();
    const aggregateId = (payload.instanceId as string) ?? (payload.taskId as string) ?? commandId;
    const event = new KafkaCommand('quantic.commands', aggregateId, {
      commandId, commandType,
      correlationId,
      sourceApp: process.env.APP_NAME ?? 'your-app',
      timestamp: new Date().toISOString(),
      userId, userRoles, payload,
    }, correlationId);
    await this.kafkaPublisher.publish(event);
    return commandId;
  }

  private async post<T>(path: string, body: unknown): Promise<T> { /* ... */ }
  private async get<T>(path: string): Promise<T> { /* ... */ }
}
```

## Workflow Start Idempotency (MANDATORY)

Every `startProcess` call MUST carry an idempotency key — QuanticFlow dedups instance starts via `correlationId`. Without it, a client retry or Kafka redelivery of the dispatching command creates a **duplicate process instance**. (Kafka mutations already carry `commandId`; the HTTP start path was historically the one channel with no idempotency story.)

- Derive the key from **business identity** (e.g. `orderId`), never from volatile fields (timestamps, request UUIDs) — a volatile key gets a unique value per dispatch and defeats dedup.
- The framework `@Workflow` path defaults the key to `sha256(processDefinitionId + ':' + stableStringify(command))`; commands with volatile fields must supply a custom `idempotencyKey: (cmd) => string`.
- A repeated key returns the existing instance as a normal `WorkflowStartResult` (status `'STARTED'`) — callers cannot distinguish "started" from "already running".

## `@Workflow` Decorator Semantics (framework path)

If commands use `@Workflow(processDefinitionId, options)` from `@quanticjs/workflow` instead of calling `WorkflowClientService` explicitly:

- **Replacement semantics:** the command handler does NOT run — the workflow engine owns execution and calls back via service tasks. The terminal result is `Result<WorkflowCommandResult>` (dispatch as `commandBus.execute<Result<WorkflowCommandResult>>(cmd)`). A registered `ICommandHandler` is only the *fallback* path (runs under `fallback: 'skip'` when the engine is down, or when no engine is bound). Dev mode logs a one-time warning per command type.
- **`fallback: 'queue'` is removed** — only `'throw' | 'skip'` exist; `'queue'` is a compile error in v7. Queue-on-failure = `fallback: 'skip'` + outbox publish from the fallback handler.
- `idempotencyKey: (cmd) => string` overrides the default key derivation (see above).

## Service-Task Callback Endpoint (HMAC self-auth)

When `serviceTaskHandling.mode` includes `'callback'`, QuanticFlow calls back into the app at `POST /workflow-callback/service-task`. Security requirements:

- **`callbackSecret` is required in production** — `QuanticFlowWorkflowModule.forRoot()` throws at boot without it when callback mode is enabled. Dev without a secret logs a warning and skips verification. Independently of the boot check, in production the controller rejects requests with 403 when no secret is configured.
- Signature arrives in the `x-callback-signature` header as a hex-encoded HMAC-SHA256 over the **raw request body bytes**, compared with `crypto.timingSafeEqual` (with a length pre-check). Consumer apps MUST create the app with `NestFactory.create(AppModule, { rawBody: true })` — with a secret set and no rawBody, every callback 403s.
- The route is `@Public()` and self-authenticating via HMAC — the global `JwtAuthGuard` does not apply. Therefore apps MUST add rate limiting on `/workflow-callback/*` (`@nestjs/throttler` or ingress-level).
- Failure semantics: an unregistered service task signals `'handler-not-found'` back to the engine; a handler exception returns `signal: 'handler-error'` (not a 500).

If the app handles service tasks via the event channel only (`mode: 'event'` — a Redis Streams consumer on `quantic:events:services` by default, configurable via `serviceTaskHandling.streamKey`/`consumerGroup`/`consumerName`), no callback secret is needed — but state the choice explicitly in the module options. Note `mode: 'event'` requires `REDIS_CLIENT` in the DI container; without it the consumer logs a warning and is disabled.

### QuanticFlowWorkflowModule Options

- `requestTimeout` (default 10000ms) bounds engine HTTP calls AND the Keycloak token fetch — it is a module option on `QuanticFlowWorkflowModule.forRoot()`, NOT an env var.
- `auth.keycloakInternalUrl` (fallback `keycloakUrl`) selects the token endpoint host — relevant for Docker networking (container-network URL vs. browser-facing URL).

## Command Envelope Format

> The Kafka command envelope and the `quantic.commands` / `quantic.commands.results.*` topics are a **QuanticFlow contract (verify against the QuanticFlow repo)** — not framework facts shipped by `@quanticjs/*`.

Every command published to `quantic.commands` must include:

| Field | Type | Description |
|---|---|---|
| `commandId` | UUID | Unique per command — used for idempotency |
| `commandType` | string | **Lowercase**: `signalprocess`, `claimtask`, `executeaction`, etc. |
| `correlationId` | UUID | Trace correlation across services |
| `sourceApp` | string | Your app name (e.g., `your-app`) |
| `timestamp` | ISO 8601 | When the command was published |
| `userId` | string | **Top-level** — who triggered it. NOT inside `payload` |
| `userRoles` | string[] | **Top-level** — their workflow roles. NOT inside `payload` |
| `payload` | object | Command-specific fields |

### Command Types

| Command | `commandType` | `payload` fields |
|---|---|---|
| Signal a process | `signalprocess` | `instanceId`, `signal`, `data?` |
| Abort a process | `abortprocess` | `instanceId`, `reason?` |
| Suspend a process | `suspendprocess` | `instanceId`, `reason?` |
| Resume a process | `resumeprocess` | `instanceId`, `reason?` |
| Set variables | `setvariables` | `instanceId`, `variables` |
| Claim a task | `claimtask` | `taskId` |
| Unclaim a task | `unclaimtask` | `taskId` |
| Execute task action | `executeaction` | `taskId`, `actionName`, `data?` |
| Reassign a task | `reassigntask` | `taskId`, `newUserId?`, `newRole?` |

## Consumer Constructor Pattern (MANDATORY)

All Kafka consumers extend `KafkaEventConsumer` and inject config via DI tokens provided by `QuanticEventsKafkaModule.forRoot()`:

```typescript
import { Inject, Injectable, Optional } from '@nestjs/common';
import { InboxService } from '@quanticjs/events-core';
import {
  KafkaConsumerStatusRegistry,
  KafkaEventConsumer,
  KafkaEventMetrics,
  KAFKA_OPTIONS,
  type KafkaEvent,
  type KafkaEventsModuleOptions,
} from '@quanticjs/events-kafka';
import { DataSource } from 'typeorm';

@Injectable()
export class MyConsumer extends KafkaEventConsumer {
  readonly topic = 'quantic.events.TaskCreatedEvents.my-definition';
  readonly groupId = 'your-app-my-consumer';

  constructor(
    @Inject(KAFKA_OPTIONS) config: KafkaEventsModuleOptions,
    @Inject('KAFKA_METRICS') metrics: KafkaEventMetrics,
    @Optional() inbox?: InboxService,
    @Optional() dataSource?: DataSource,
    @Optional() statusRegistry?: KafkaConsumerStatusRegistry,
  ) {
    super(config, metrics, inbox, dataSource, statusRegistry);
  }

  async handleMessage(event: KafkaEvent): Promise<void> {
    // User context is already set by the base class — KafkaEventConsumer.processWithSpan()
    // wraps handleMessage() with runAsService(() => this.handleMessage(event), user).
    // Do NOT manually wrap with executionContextStore.run() or runAsService() here.
  }
}
```

**Warning (applies to every `KafkaEventConsumer` constructor in this file):** always pass the full pattern `super(config, metrics, inbox, dataSource)` — `inbox`/`dataSource` are optional, but omitting them silently downgrades inbox-enabled consumers to at-least-once delivery. Omitting `statusRegistry` (5th arg) removes the consumer from the `kafka_consumers` readiness check. Note: `CqrsKafkaConsumer` subclasses currently cannot forward the status registry (framework limitation — base passes only 4 args).

**Important:** `KafkaEventConsumer.processWithSpan()` automatically wraps `handleMessage()` with `runAsService(() => this.handleMessage(event), user)`, extracting user from the Kafka event envelope. Consumers do **not** need manual context setup — `callerType` is `'internal'` and user is available via `getCurrentUser()`.

## Command Result Consumer

Subscribe to the **per-app** topic `quantic.commands.results.<sourceApp>` to handle ack/nack from QuanticFlow. The topic is per-app so no `sourceApp` filtering is needed:

```typescript
@Injectable()
export class WorkflowCommandResultConsumer extends KafkaEventConsumer {
  readonly topic = `quantic.commands.results.${process.env.APP_NAME ?? 'your-app'}`;
  readonly groupId = 'your-app-cmd-results';

  constructor(
    @Inject(KAFKA_OPTIONS) config: KafkaEventsModuleOptions,
    @Inject('KAFKA_METRICS') metrics: KafkaEventMetrics,
    @InjectPinoLogger(WorkflowCommandResultConsumer.name) private readonly appLogger: PinoLogger,
    @Optional() inbox?: InboxService,
    @Optional() dataSource?: DataSource,
  ) {
    super(config, metrics, inbox, dataSource);
  }

  async handleMessage(event: KafkaEvent): Promise<void> {
    const result = event.payload as unknown as CommandResultPayload;

    if (result.status === 'rejected') {
      this.appLogger.error(
        { commandId: result.commandId, commandType: result.commandType, error: result.error },
        'Workflow command rejected',
      );
    }
  }
}
```

### CommandResultPayload Shape

```typescript
interface CommandResultPayload {
  commandId: string;
  correlationId: string;
  commandType: string;
  sourceApp: string;
  status: 'accepted' | 'rejected';
  error?: { code: string; message: string };
  processedAt: string;
}
```

## Caller Pattern — userId and userRoles Required

All mutation methods require `userId` and `userRoles` in an `opts` object. These are envelope fields, not payload:

```typescript
// ✅ CORRECT — Kafka style (returns commandId, not the result)
const commandId = await this.workflowClient.signalProcess(instanceId, signal, {
  userId,
  userRoles,
  data: { someData: true },
});

const commandId = await this.workflowClient.claimTask(taskId, { userId, userRoles });

const commandId = await this.workflowClient.executeAction(taskId, actionName, {
  userId,
  userRoles,
  data: payload,
});

// ❌ WRONG — old HTTP style (positional args, no userId/userRoles)
await this.workflowClient.signalProcess(instanceId, signal, { someData: true });
await this.workflowClient.claimTask(taskId, userId);
await this.workflowClient.completeTask(taskId, action, payload);
```

## Per-Definition Kafka Topic Routing

QuanticFlow publishes workflow events to **per-definition Kafka topics**. Each workflow definition gets its own topic, so consumers only receive events for their process type.

### Topic Format

```
quantic.events.<EventType>s.<definitionId>
```

| Event | Topic Example |
|---|---|
| `TaskCreatedEvent` | `quantic.events.TaskCreatedEvents.order-approval` |
| `TaskClaimedEvent` | `quantic.events.TaskClaimedEvents.order-approval` |
| `TaskCompletedEvent` | `quantic.events.TaskCompletedEvents.order-approval` |
| `ProcessStartedEvent` | `quantic.events.ProcessStartedEvents.order-approval` |
| `ProcessCompletedEvent` | `quantic.events.ProcessCompletedEvents.order-approval` |
| `ProcessAbortedEvent` | `quantic.events.ProcessAbortedEvents.order-approval` |

### Consuming Workflow Events

Subscribe only to the definition you care about — no filtering, no wasted reads:

```typescript
@Injectable()
export class OrderTaskEventConsumer extends KafkaEventConsumer {
  readonly topic = 'quantic.events.TaskCreatedEvents.order-approval';
  readonly groupId = 'your-app-orders';

  constructor(
    @Inject(KAFKA_OPTIONS) config: KafkaEventsModuleOptions,
    @Inject('KAFKA_METRICS') metrics: KafkaEventMetrics,
    private readonly commandBus: CommandBus,
  ) {
    super(config, metrics);
  }

  async handleMessage(event: KafkaEvent): Promise<void> {
    // React to task creation — e.g., send notification, update order status
  }
}
```

### Multiple Definitions = Multiple Consumers

If your app has multiple workflow types, create one consumer per definition per event type:

```typescript
// order-approval workflow events
@Injectable()
export class OrderTaskCreatedConsumer extends KafkaEventConsumer {
  readonly topic = 'quantic.events.TaskCreatedEvents.order-approval';
  // ...
}

// build-kickoff workflow events
@Injectable()
export class BuildTaskCreatedConsumer extends KafkaEventConsumer {
  readonly topic = 'quantic.events.TaskCreatedEvents.build-kickoff';
  // ...
}
```

## What Goes in Application Code vs. QuanticFlow

| Belongs in **your app** | Belongs in **QuanticFlow** (standalone) |
|---|---|
| `WorkflowClientService` (hybrid HTTP + Kafka adapter) | Process execution and state machine logic |
| Definition-scoped Kafka event consumers | Task routing and assignment rules |
| `WorkflowCommandResultConsumer` for ack/nack handling | Process instance lifecycle management |
| Domain reactions to workflow events (notifications, status updates) | Task inbox queries and filtering |
| Commands that call `WorkflowClientService` to start/signal/complete | State transition persistence |
| Workflow definition JSON/BPMN files (pushed to QuanticFlow via API) | Process evaluation and branching |
| Role and permission definitions for workflow steps | Command idempotency deduplication |

## Inter-Module Communication

Other modules interact with workflows through the bus — never by importing workflow services directly:

```typescript
// ✅ CORRECT — dispatch via CommandBus, handler uses WorkflowClientService
this.commandBus.execute(new StartOrderApprovalCommand(orderId, variables));
this.commandBus.execute(new CompleteOrderTaskCommand(taskId, action, userId, userRoles));

// ❌ WRONG — direct service import from another module
await this.workflowClient.startProcess('order-approval', variables);
```

## Environment Variables

```bash
QUANTICFLOW_URL=http://quanticflow:3000   # Docker Compose service name (internal port) — used by startProcess (HTTP)
KAFKA_BROKERS=kafka:9092                  # Kafka broker list — used by all Kafka commands and consumers
APP_NAME=your-app                     # Identifies this app in command envelopes and result topic
```

## NEVER

- **NEVER** embed QuanticFlow as a library — it's a standalone service, connect via HTTP + Kafka
- **NEVER** access QuanticFlow's database directly — use its REST API or Kafka commands
- **NEVER** write your own process state machine — use QuanticFlow
- **NEVER** write your own task assignment/routing logic — configure it in process definitions
- **NEVER** subscribe to generic event topics and filter — use per-definition topic names
- **NEVER** import workflow module services into other modules — use CommandBus/QueryBus
- **NEVER** make HTTP calls to QuanticFlow without a circuit breaker
- **NEVER** poll for workflow state changes when Kafka consumers are available
- **NEVER** use HTTP for **app-initiated** workflow mutations (signal, claim, complete, abort) from your own `WorkflowClientService` — use Kafka commands via `publishCommand`. (The framework's `@quanticjs/workflow-quanticflow` adapter itself signals/aborts over HTTP for `@Workflow`-decorated commands and service-task completion signals — that internal path is exempt.)
- **NEVER** put `userId` or `userRoles` inside the command `payload` — they are top-level envelope fields
- **NEVER** use uppercase command type values — always lowercase (`signalprocess`, not `SignalProcess`)
- **NEVER** omit `commandId` from Kafka commands — it's required for idempotency deduplication
- **NEVER** use `KafkaProducer` directly — use `KafkaEventPublisher` which accepts `DomainEvent` instances
- **NEVER** pass brokers/clientId directly to consumer `super()` — use `@Inject(KAFKA_OPTIONS)` and `@Inject('KAFKA_METRICS')` DI tokens
- **NEVER** omit `correlationId` from `KafkaCommand` constructor — it enables distributed tracing via `DomainEvent`
- **NEVER** use a topic prefix other than `quantic.*` — all topics use the `quantic.*` prefix
- **NEVER** call `startProcess` without an idempotency key (`correlationId`) — retries/redeliveries create duplicate process instances
- **NEVER** derive an idempotency key from volatile fields (timestamps, request UUIDs) — use business identity
- **NEVER** use `@Workflow(..., { fallback: 'queue' })` — removed in v7; use `fallback: 'skip'` + outbox publish
- **NEVER** enable callback mode in production without `callbackSecret` + `rawBody: true` + rate limiting on `/workflow-callback/*`
- **NEVER** manually wrap `handleMessage()` with `executionContextStore.run()` or `runAsService()` — the base class `KafkaEventConsumer` handles context setup automatically
