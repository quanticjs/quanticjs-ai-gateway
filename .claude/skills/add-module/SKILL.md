# Add Module (Bounded Context)

## Steps
1. **Create module directory** — `src/<module-name>/`
2. **Create subdirectories:**
   ```
   src/<module-name>/
   ├── commands/       # Command classes + handlers + validators
   ├── queries/        # Query classes + handlers
   ├── entities/       # TypeORM entities
   ├── dtos/           # Request/response DTOs
   ├── controllers/    # THIN controllers
   ├── services/       # Adapters (external integrations)
   └── <module-name>.module.ts
   ```
3. **Create module file:**
   ```typescript
   import { Module } from '@nestjs/common';
   import { CqrsModule } from '@nestjs/cqrs';
   import { TypeOrmModule } from '@nestjs/typeorm';

   @Module({
     imports: [
       CqrsModule,
       TypeOrmModule.forFeature([/* entities */]),
     ],
     controllers: [/* controllers */],
     providers: [
       ...CommandHandlers,
       ...QueryHandlers,
       ...Validators,
     ],
   })
   export class XxxModule {}
   ```
4. **Register in AppModule** — add to imports array in `src/app.module.ts`
5. **Create PostgreSQL schema** — migration: `CREATE SCHEMA IF NOT EXISTS <module_name>;`
6. **Add initial entity** — run `/add-entity`

## App Module Checklist

When registering a new module in `app.module.ts`, ensure these `.forRoot()` modules are present (import once, never in feature modules):

```typescript
@Module({
  imports: [
    QuanticModule.forRoot({ redis: { url: process.env.REDIS_URL } }),
    QuanticHealthModule.forRoot(),        // health probes — auto-detects DB + Redis
    ScheduleModule.forRoot(),
    LoggerModule.forRoot(pinoConfig),
    // ... feature modules
    XxxModule,                            // your new module
  ],
})
export class AppModule {}
```

## Graceful Shutdown

If the service has custom resources (queue workers, websockets, outbox publisher), extend `GracefulShutdownService`:

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

Register `AppShutdownService` in `app.module.ts` providers. Base class handles DB and Redis cleanup automatically.

## Rules
- Each module owns its own PostgreSQL schema — no cross-schema queries
- Modules communicate through `CommandBus`/`QueryBus` — never import another module's services or repositories
- Only commands, queries, and DTOs are exported from a module
- Import from `@quanticjs/core` — never import from sibling modules directly
- Inter-module async communication uses Apache Kafka
- `.forRoot()` modules (ScheduleModule, LoggerModule, QuanticHealthModule, etc.) go ONLY in `app.module.ts`
- `QuanticHealthModule.forRoot()` is MANDATORY — every service needs health probes
- Services with queue workers or websockets MUST extend `GracefulShutdownService` and close resources in `drainWork()`
