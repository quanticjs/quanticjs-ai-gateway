# Add External Integration

## When to Use
When the project integrates with an external system (third-party API, AI provider, partner service, or **QuanticFlow workflow engine**).

## Steps
1. **Create adapter service** in `src/<module>/services/<SystemName>Adapter.ts`:
   ```typescript
   @Injectable()
   export class AcmeAdapter {
     private readonly logger = new Logger(AcmeAdapter.name);
     private readonly baseUrl: string;
     private readonly apiKey: string;

     constructor() {
       this.baseUrl = process.env.ACME_API_URL!;
       this.apiKey = process.env.ACME_API_KEY!;
     }

     async createResource(payload: CreatePayload): Promise<AcmeResponse> {
       return this.request('POST', '/api/resources', payload);
     }

     private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
       const url = `${this.baseUrl}${path}`;
       const response = await fetch(url, {
         method,
         headers: {
           'Content-Type': 'application/json',
           'Authorization': `Bearer ${this.apiKey}`,
           'X-Idempotency-Key': crypto.randomUUID(),
         },
         body: body ? JSON.stringify(body) : undefined,
       });

       if (response.status === 429) {
         const retryAfter = parseInt(response.headers.get('Retry-After') || '5');
         await new Promise(r => setTimeout(r, retryAfter * 1000));
         return this.request(method, path, body);
       }

       if (!response.ok) {
         const errorBody = await response.text();
         this.logger.error({ method, path, status: response.status }, 'External API failed');
         throw new Error(`${method} ${path}: ${response.status}`);
       }

       return response.json() as T;
     }
   }
   ```
2. **Define types** for request/response payloads
3. **Create command with @Validate** — every integration command needs validation:
   ```typescript
   @Validate(SyncResourceValidator)
   @DistributedLock('sync-resource:{resourceId}')
   export class SyncResourceCommand {
     constructor(
       public readonly resourceId: string,
       public readonly data: Record<string, unknown>,
     ) {}
   }
   ```
4. **Create .validator.ts** — co-located Zod schema
5. **Use in command handler** — inject adapter, use `getTransactionalRepo()`:
   ```typescript
   @CommandHandler(SyncResourceCommand)
   export class SyncResourceHandler implements ICommandHandler<SyncResourceCommand> {
     constructor(
       private readonly acme: AcmeAdapter,
       @InjectRepository(Resource) private readonly resourceRepo: Repository<Resource>,
     ) {}

     async execute(command: SyncResourceCommand): Promise<Result<ResourceDto>> {
       const resourceRepo = getTransactionalRepo(this.resourceRepo);

       const externalResult = await this.acme.createResource({
         reference: command.resourceId,
         ...command.data,
       });

       const resource = await resourceRepo.save(
         resourceRepo.create({
           ...command,
           externalId: externalResult.id,
           syncStatus: 'synced',
         }),
       );

       return Result.success(toDto(resource));
     }
   }
   ```
6. **Add webhook controller** (if the external system sends callbacks):
   ```typescript
   @Public()
   @Controller('webhooks/<system>')
   export class AcmeWebhookController {
     constructor(private readonly commandBus: CommandBus) {}

     @Post()
     async handleWebhook(
       @Req() req: RawBodyRequest<Request>,
       @Headers('x-signature') signature: string,
     ) {
       const expectedSig = crypto
         .createHmac('sha256', process.env.ACME_WEBHOOK_SECRET!)
         .update(req.rawBody!)
         .digest('hex');

       if (signature !== expectedSig) {
         throw new UnauthorizedException('Invalid webhook signature');
       }

       const event = JSON.parse(req.rawBody!.toString());
       return this.commandBus.execute(new HandleWebhookEventCommand(event));
     }
   }
   ```
7. **Add environment variables** to `.env` and `docker-compose.yml`
8. **Add circuit breaker** (MANDATORY for all external integrations):
   ```typescript
   import { createCircuitBreaker } from '@quanticjs/core';

   private readonly breaker = createCircuitBreaker({
     maxRetries: 2,              // 3 total attempts, exponential backoff
     consecutiveFailures: 5,     // open circuit after 5 consecutive failures
     halfOpenAfterMs: 30_000,    // test one request after 30s
   });

   async createResource(payload: CreatePayload): Promise<AcmeResponse> {
     return this.breaker.execute(() => this.request('POST', '/api/resources', payload));
   }
   ```
   - **States:** Closed (normal) → Open (fast-fail) → Half-open (test one) → Closed on success
   - 4xx responses are **never retried** and do not count toward circuit-breaker failures
   - Each integration gets its **own** circuit breaker instance — never share across integrations
9. **Add tests** — run `/write-backend-tests` for handler, validator, and webhook controller

## QuanticFlow Integration Template

QuanticFlow is a standalone workflow engine. Connect via hybrid HTTP + Kafka. `startProcess` stays HTTP (needs synchronous `instanceId`). All other mutations use Kafka commands. See `/add-workflow` for the full `WorkflowClientService` with Kafka command publishing.

### 1. WorkflowClientService (hybrid HTTP + Kafka adapter)

```typescript
import { Injectable } from '@nestjs/common';
import { createCircuitBreaker } from '@quanticjs/core';
import { DomainEvent } from '@quanticjs/events-core';
import { KafkaEventPublisher } from '@quanticjs/events-kafka';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'crypto';

// See /add-workflow for full implementation with KafkaCommand class and all methods.

@Injectable()
export class WorkflowClientService {
  private readonly baseUrl = process.env.QUANTICFLOW_URL ?? 'http://quanticflow:3002';
  private readonly breaker = createCircuitBreaker({ maxRetries: 2, consecutiveFailures: 5, halfOpenAfterMs: 30_000 });

  constructor(
    @InjectPinoLogger(WorkflowClientService.name) private readonly logger: PinoLogger,
    private readonly kafkaPublisher: KafkaEventPublisher,
  ) {}

  // HTTP — startProcess only (needs instanceId synchronously)
  async startProcess(definitionId: string, variables: Record<string, unknown>): Promise<{ instanceId: string }> {
    return this.breaker.execute(() => this.post(`/api/workflows/${definitionId}/start`, { variables }));
  }

  // Kafka — all mutations (returns commandId, fire-and-forget)
  async claimTask(taskId: string, opts: { userId: string; userRoles: string[] }): Promise<string> {
    return this.publishCommand('claimtask', opts.userId, opts.userRoles, { taskId });
  }

  async executeAction(taskId: string, actionName: string, opts: { userId: string; userRoles: string[]; data?: Record<string, unknown> }): Promise<string> {
    return this.publishCommand('executeaction', opts.userId, opts.userRoles, { taskId, actionName, data: opts.data });
  }

  // ... publishCommand, post, get — see /add-workflow for full implementation
}
```

### 2. Per-Definition Kafka Consumer

QuanticFlow publishes events to per-definition Kafka topics. Subscribe to only the definitions you care about:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import {
  KafkaEventConsumer,
  KafkaEventMetrics,
  KAFKA_OPTIONS,
  type KafkaEvent,
  type KafkaEventsModuleOptions,
} from '@quanticjs/events-kafka';

@Injectable()
export class CrTaskCreatedConsumer extends KafkaEventConsumer {
  readonly topic = 'quantic.events.TaskCreatedEvents.cr-approval';
  readonly groupId = 'delivery-hub-cr';

  constructor(
    @Inject(KAFKA_OPTIONS) config: KafkaEventsModuleOptions,
    @Inject('KAFKA_METRICS') metrics: KafkaEventMetrics,
  ) {
    super(config, metrics);
  }

  async handleMessage(event: KafkaEvent): Promise<void> {
    // React to cr-approval task creation
  }
}
```

### 3. Docker Compose Setup

```yaml
kafka:
  image: bitnami/kafka:latest
  environment:
    KAFKA_CFG_NODE_ID: 0
    KAFKA_CFG_PROCESS_ROLES: controller,broker
    KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: 0@kafka:9093
  ports:
    - "9092:9092"

quanticflow:
  image: quanticjs/quanticflow:latest
  environment:
    DATABASE_URL: postgres://postgres:postgres@postgres:5432/quanticflow
    KAFKA_BROKERS: kafka:9092
  depends_on:
    - postgres
    - kafka

backend:
  environment:
    QUANTICFLOW_URL: http://quanticflow:3002
    KAFKA_BROKERS: kafka:9092
```

## Integration Spec Template
Create `docs/integrations/<system>.md` if it doesn't exist:
```markdown
# Integration: <System Name>

## Connection
- Base URL: env `<SYSTEM>_API_URL`
- Auth: Bearer token (env `<SYSTEM>_API_KEY`)
- Rate limit: N req/min

## Endpoints
| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| POST | /api/resource | Create | `{ field: value }` | `{ id, status }` |

## Webhooks (inbound)
- URL: /webhooks/<system>
- Signature: HMAC-SHA256 in X-Signature header
- Secret: env `<SYSTEM>_WEBHOOK_SECRET`
- Events: resource.created, resource.updated

## Error Handling
- 429 → retry after Retry-After header
- 5xx → circuit breaker (5 consecutive failures → open 30s, 2 retries with exponential backoff)
```

## Rules
- NEVER hardcode API keys — always `process.env.*`
- NEVER trust inbound webhooks without signature verification
- Adapter is the ONLY class that knows the external API — handlers call adapter methods
- Store external IDs on your entities (`externalId` column) for reconciliation
- Use idempotency keys on all mutating external calls
- Log all external calls at debug level (structured JSON) for troubleshooting
- Circuit breaker on ALL external HTTP calls — prevent cascade failures
- Each integration gets its own circuit breaker — never share across integrations
- 4xx responses are never retried and don't count toward circuit-breaker failures
- All repo access via `getTransactionalRepo()` — never use `this.repo` directly in handlers
- For QuanticFlow: use per-definition Kafka topics — never subscribe to generic topics and filter
