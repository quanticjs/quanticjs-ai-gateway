# Add Event (Redis Streams)

## When to Use
When the AI gateway needs to publish or consume async events via Redis Streams.

## Publishing (already implemented)
The async generation handler publishes results to `arex:ai:results` stream:
```typescript
await this.redis.xadd(RESULT_STREAM, 'MAXLEN', '~', STREAM_MAXLEN, '*',
  'requestId', requestId,
  'status', 'success',
  'content', response.content,
  ...
);
```

## Consuming
Use `RedisStreamConsumer` base class:
```typescript
@Injectable()
export class ResultConsumer extends RedisStreamConsumer {
  readonly streamKey = 'arex:ai:results';
  readonly consumerGroup = 'ai-gateway-consumer';
  readonly consumerName = `gw-${hostname()}-${process.pid}`;

  constructor(@Optional() @Inject(REDIS_CLIENT) redis: Redis | undefined) {
    super(redis);
  }

  async handleMessage(fields: Record<string, string>): Promise<void> {
    // Process the event
  }
}
```

## Rules
- Every consumer uses a dedicated cloned connection for blocking XREADGROUP
- Shared REDIS_CLIENT for non-blocking ops only (XADD, cache)
- `onModuleInit()` for setup, `onApplicationBootstrap()` for polling
- Consumers MUST be idempotent
- Failed events → retry with backoff or dead-letter (`{stream}:dlq`)
