# Add Module

## Steps
1. **Create module directory** — `src/<module-name>/`
2. **Create subdirectories:**
   ```
   src/<module-name>/
   ├── commands/       # Command classes + handlers + validators
   ├── dtos/           # Request/response DTOs
   ├── controllers/    # THIN controllers
   ├── services/       # Provider adapters
   └── <module-name>.module.ts
   ```
3. **Create module file:**
   ```typescript
   import { Module } from '@nestjs/common';
   import { CqrsModule } from '@nestjs/cqrs';

   @Module({
     imports: [CqrsModule],
     controllers: [/* controllers */],
     providers: [
       ...CommandHandlers,
       ...Validators,
       ...Providers,
       Metrics,
     ],
   })
   export class XxxModule {}
   ```
4. **Register in AppModule** — add to imports array in `src/app.module.ts`
5. **Create metrics class** — `<module>.metrics.ts` with Prometheus counters/histograms
6. **Create provider interface** — Symbol token + interface for DI

## Rules
- Modules communicate through `CommandBus`/`QueryBus` — never import another module's services
- Only commands, queries, and DTOs are exported from a module
- `.forRoot()` modules go ONLY in `app.module.ts`
- Every provider needs a circuit breaker for external HTTP calls
