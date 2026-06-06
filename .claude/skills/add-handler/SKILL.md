# Add Handler

Create a CQRS command or query with validator and handler following the `@quanticjs/core` patterns.

## Usage
```
/add-handler CreateItem in project
/add-handler GetUserProfile in identity
```

## Steps

1. **Create command or query class** in `src/<module>/commands/` or `src/<module>/queries/`
   - Add `@Validate(XxxValidator)` decorator on the command class (MANDATORY)
   - Add optional decorators as needed: `@Cache`, `@DistributedLock`, `@FeatureFlag`
   ```typescript
   import { Validate, DistributedLock } from '@quanticjs/core';

   @Validate(CreateXxxValidator)
   @DistributedLock('create-xxx:{name}')  // only if critical section needed
   export class CreateXxxCommand {
     constructor(public readonly name: string, public readonly userId: string) {}
   }
   ```

2. **Create `.validator.ts`** co-located with the command — ALL validation logic lives here:
   ```typescript
   import { z } from 'zod';
   import { ICommandValidator, validateCommand } from '@quanticjs/core';

   export class CreateXxxValidator implements ICommandValidator<CreateXxxCommand> {
     private schema = z.object({
       name: z.string().min(1).max(100),
       // Business rules go here as .refine() / .superRefine()
     });
     validate(command: CreateXxxCommand) { return validateCommand(this.schema, command); }
   }
   ```

3. **Create handler class** implementing `ICommandHandler<T>` or `IQueryHandler<T>`:
   ```typescript
   import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
   import { InjectRepository } from '@nestjs/typeorm';
   import { Repository } from 'typeorm';
   import { getTransactionalRepo, Result } from '@quanticjs/core';

   @CommandHandler(CreateXxxCommand)
   export class CreateXxxHandler implements ICommandHandler<CreateXxxCommand> {
     constructor(@InjectRepository(Xxx) private readonly xxxRepo: Repository<Xxx>) {}

     async execute(command: CreateXxxCommand): Promise<Result<XxxDto>> {
       const xxxRepo = getTransactionalRepo(this.xxxRepo);  // UnitOfWork
       const entity = xxxRepo.create({ name: command.name });
       await xxxRepo.save(entity);
       return Result.success(toDto(entity));
     }
   }
   ```

4. **Register** handler and validator in module's `providers` array
5. **Add tests** — run `/write-backend-tests` for the handler and validator

## Pipeline Behavior Chain
**Commands:** `Log (global) → FeatureFlag → Validate → Cache → DistributedLock → Transactional (auto) → Handler`
**Queries:** `Log (global) → FeatureFlag → Validate → Cache → Handler`

## Available Decorators
| Decorator | When to Use |
|-----------|-------------|
| `@Validate(ValidatorClass)` | Every command with external input (MANDATORY) |
| `@DistributedLock('key:{prop}')` | Commands with critical sections — race conditions, concurrent writes, resource contention |
| `@Cache('key:{prop}', { ttlSeconds })` | Read-heavy queries |
| `@FeatureFlag('release-module-feature')` | Feature-gated commands (see naming below) |
| `@IsolatedTransaction()` | Audit/notification commands that must commit independently |

## Feature Flag Naming & Lifecycle

When adding `@FeatureFlag`, use the correct naming convention and fallback:

| Category | Name format | Lifetime | Fallback |
|---|---|---|---|
| **Release** | `release-{module}-{feature}` | Remove within 30 days of full rollout | `throw` (default) |
| **Kill switch** | `kill-{module}-{feature}` | Permanent | `throw` (default) |
| **Experiment** | `experiment-{module}-{feature}` | Remove within 90 days | `default` (control variant) |

```typescript
@FeatureFlag('release-billing-invoices')                                    // blocks if disabled
@FeatureFlag('kill-payments-processing')                                    // blocks if disabled
@FeatureFlag('experiment-scoring-v2', { fallback: 'default', defaultValue: oldResult })
@FeatureFlag('release-notifications-email', { fallback: 'skip' })           // silently skips
```

If `UNLEASH_URL` is not set, all flags pass — local dev and tests work without Unleash.

## Rules
- Command class MUST have `@Validate(XxxValidator)` — without it, the `.validator.ts` is dead code
- ALL validation in `.validator.ts` using Zod — NEVER validate inline in handlers
- Business rules (age >= 18, email unique, date range valid) → Zod `.refine()` / `.superRefine()` in validator
- Handler uses `getTransactionalRepo()` for all repo access — UnitOfWork is automatic
- Handlers NEVER contain validation logic — no `if (x < y) return Result.validationError()`
- Handlers NEVER throw exceptions — return `Result.failure()` / `Result.notFound()` / `Result.conflict()` etc.
- If handler has a critical section, add `@DistributedLock('key:{prop}')` on the **command class**
- Return `Result<T>` from handlers — never throw for business errors
- Feature flags: NEVER nest multiple `@FeatureFlag` on one handler — one handler, one flag
- Feature flags: NEVER use on infrastructure code (migrations, middleware) — use env vars instead
