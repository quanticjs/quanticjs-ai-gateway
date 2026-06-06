# Add Domain Event

## Event Flow
```
Handler → OutboxEvent (same DB transaction) → OutboxPublisherService (poll) → Kafka → Consumer
```

Events use the **outbox pattern** — the event record is written to the database in the same transaction as the entity mutation, guaranteeing atomicity. A background publisher polls the outbox and publishes to Kafka.

## Steps
1. **Create domain event in the handler** after successful mutation:
   ```typescript
   import { getTransactionalRepo, Result } from '@quanticjs/core';
   import { OutboxEvent, DomainEvent, OutboxEventStatus } from '@quanticjs/events-core';

   @CommandHandler(CreateItemCommand)
   export class CreateItemHandler implements ICommandHandler<CreateItemCommand> {
     constructor(
       @InjectRepository(Item) private readonly itemRepo: Repository<Item>,
       @InjectRepository(OutboxEvent) private readonly outboxRepo: Repository<OutboxEvent>,
     ) {}

     async execute(command: CreateItemCommand): Promise<Result<ItemDto>> {
       const itemRepo = getTransactionalRepo(this.itemRepo);
       const outboxRepo = getTransactionalRepo(this.outboxRepo);

       const item = itemRepo.create({ name: command.name });
       await itemRepo.save(item);

       const domainEvent = new DomainEvent(
         'item.created',        // eventType
         item.id,               // aggregateId (used as Kafka message key)
         { name: item.name },   // payload (minimal — IDs preferred)
         command.organizationId, // organizationId (optional)
         undefined,             // routingKey (optional)
         command.correlationId, // correlationId (optional — traces originating request)
         undefined,             // causationId (optional — ID of the causing event)
       );

       const outboxEvent = new OutboxEvent();
       outboxEvent.eventType = domainEvent.eventType;
       outboxEvent.aggregateId = domainEvent.aggregateId;
       outboxEvent.topic = domainEvent.topic;
       outboxEvent.payload = domainEvent.payload;
       outboxEvent.organizationId = command.organizationId ?? null;
       outboxEvent.correlationId = domainEvent.correlationId ?? null;
       outboxEvent.causationId = domainEvent.causationId ?? null;
       outboxEvent.status = OutboxEventStatus.Pending;
       await outboxRepo.save(outboxEvent);

       return Result.success(toDto(item));
     }
   }
   ```

2. **Topic name** is derived from eventType: `item.created` → `quantic.events.items`

3. **OutboxPublisherService** (from `@quanticjs/events-core`) polls pending events:
   - Reads pending OutboxEvents every 100ms (batch of 50)
   - Publishes to Kafka via `KafkaEventPublisher`
   - Marks as Published or Failed (max 5 retries with exponential backoff → DLQ)

## Per-Definition Routing (Workflow Events)

QuanticFlow publishes workflow events with a **routing key** (the definition ID). This produces per-definition topics so consumers only receive events for their workflow type:

```
quantic.events.<EventType>s.<routingKey>
```

| Event | Routing Key | Topic |
|---|---|---|
| `TaskCreatedEvent` | `cr-approval` | `quantic.events.TaskCreatedEvents.cr-approval` |
| `ProcessCompletedEvent` | `po-approval` | `quantic.events.ProcessCompletedEvents.po-approval` |

To add a routing key to your own domain events:

```typescript
const event = new DomainEvent(
  'order.shipped',          // eventType
  order.id,                 // aggregateId
  { trackingNumber },       // payload
  undefined,                // organizationId (optional)
  order.warehouseId,        // routingKey — appended to topic
);
// Topic: quantic.events.orders.warehouse-123
```

Without a routing key, the topic is just `quantic.events.<category>s` (generic, shared).

## Event Naming Convention
| Event Type | Topic | When |
|------------|-------|------|
| `item.created` | `quantic.events.items` | After entity creation |
| `item.updated` | `quantic.events.items` | After entity update |
| `item.deleted` | `quantic.events.items` | After soft delete |
| `project.status.changed` | `quantic.events.projects` | After status transition |

## Consuming Events

Extend `KafkaEventConsumer` from `@quanticjs/events-kafka`. The base class handles consumer group coordination, offset management, retry logic, and distributed trace propagation.

### Generic Consumer (all events for a category)

```typescript
import { Injectable } from '@nestjs/common';
import { KafkaEventConsumer, KafkaEvent } from '@quanticjs/events-kafka';

@Injectable()
export class ItemEventConsumer extends KafkaEventConsumer {
  readonly topic = 'quantic.events.items';
  readonly groupId = 'project-planning';

  protected shouldHandle(event: KafkaEvent): boolean {
    return event.type === 'item.created';
  }

  async handleMessage(event: KafkaEvent): Promise<void> {
    // Handle idempotently — events may be delivered more than once
    // event.correlationId and event.causationId are available for tracing
  }
}
```

### Definition-Scoped Consumer (workflow events)

```typescript
@Injectable()
export class CrTaskCreatedConsumer extends KafkaEventConsumer {
  readonly topic = 'quantic.events.TaskCreatedEvents.cr-approval';
  readonly groupId = 'delivery-hub-cr';

  async handleMessage(event: KafkaEvent): Promise<void> {
    // Only cr-approval TaskCreated events arrive here — no filtering needed
  }
}
```

## Lifecycle

The `KafkaEventConsumer` base class manages the full Kafka lifecycle automatically:

- **`onModuleInit()`** — creates Kafka consumer/producer, subscribes to topic
- **`onApplicationBootstrap()`** — starts consuming messages (non-blocking)
- **`onModuleDestroy()`** — disconnects gracefully, commits final offsets

No manual lifecycle management is needed in subclasses.

## Schema Evolution

Events include a `version` field in the envelope. Adding optional fields does not bump the version. Adding required fields or changing types requires a version bump. Consumers MUST tolerate unknown fields (forward compatibility).

```typescript
async handleMessage(event: KafkaEvent): Promise<void> {
  if (event.version === 1) {
    await this.handleV1(event.payload);
  } else if (event.version >= 2) {
    await this.handleV2(event.payload);
  }
}
```

## Retry & Dead-Letter Policy

**Poison pills (deserialization errors):**
- Invalid JSON or missing required envelope fields (`id`, `type`, `version`) → immediate DLQ with zero retries
- DLQ payload includes `errorCategory: 'DESERIALIZATION'`
- The base class handles this automatically — `handleMessage` is never called for poison pills

**Processing errors:**
- Max retries: 5 with exponential backoff + jitter
- Backoff: `min(1s × 2^attempt + random(0,1000ms), 30s)`
- DLQ payload includes `errorCategory: 'PROCESSING'`

**General:**
- Dead-letter topic: `{topic}.dlq` (e.g., `quantic.events.orders.dlq`) with 30-day retention
- Failed events are NEVER silently dropped
- Long-running handlers (>30s) MUST call `this.heartbeat()` periodically
- If a downstream dependency is unhealthy, call `this.pause()` to stop fetching; `this.resume()` when recovered

## Distributed Tracing

Trace context (W3C `traceparent`/`tracestate`) is propagated automatically through Kafka message headers. The producer injects the current OpenTelemetry context, and the consumer extracts it to create a linked child span. No manual setup is needed — install `@opentelemetry/api` as a peer dependency and the tracing activates.

## Rules
- ALWAYS use outbox pattern — never publish directly to Kafka (data loss on crash)
- OutboxEvent is saved in the SAME transaction as the entity mutation
- Import `DomainEvent` and `OutboxEvent` from `@quanticjs/events-core`
- Import `KafkaEventConsumer` and `KafkaEvent` from `@quanticjs/events-kafka`
- Event payloads should be minimal — include IDs, not full entities
- Consumers must be idempotent — events may be delivered more than once
- For workflow events, use per-definition topics — never subscribe to a generic topic and filter
- NEVER start consuming in `onModuleInit()` — use `onApplicationBootstrap()`
- NEVER publish events before the transaction commits
- NEVER auto-create topics in production — all topics must be pre-created with explicit partition counts
- NEVER reject unknown fields in consumers — ignore them for forward compatibility
- NEVER retry deserialization errors — they go directly to DLQ
- All repo access via `getTransactionalRepo()`
