# Add Handler

Create a CQRS command or query with validator and handler following `@quanticjs/core` patterns.

## Usage
```
/add-handler GenerateSync in generate
/add-handler EmbedTexts in embed
```

## Steps

1. **Create command class** in `src/<module>/commands/`
   - Add `@Validate(XxxValidator)` decorator (MANDATORY)
   ```typescript
   import { Validate } from '@quanticjs/core';

   @Validate(GenerateSyncValidator)
   export class GenerateSyncCommand {
     constructor(
       public readonly systemPrompt: string,
       public readonly userPrompt: string,
       public readonly maxTokens: number | undefined,
       public readonly model: string | undefined,
       public readonly jsonSchema: Record<string, unknown> | undefined,
       public readonly purpose: string | undefined,
       public readonly callerService: string | undefined,
     ) {}
   }
   ```

2. **Create `.validator.ts`** co-located with the command:
   ```typescript
   import { z } from 'zod';
   import { ICommandValidator, validateCommand } from '@quanticjs/core';

   export class GenerateSyncValidator implements ICommandValidator<GenerateSyncCommand> {
     private schema = z.object({
       systemPrompt: z.string().min(1).max(100_000),
       userPrompt: z.string().min(1).max(100_000),
       maxTokens: z.number().int().min(1).max(32_000).optional(),
       model: z.string().max(100).optional(),
       jsonSchema: z.record(z.unknown()).optional(),
       purpose: z.string().max(200).optional(),
       callerService: z.string().max(100).optional(),
     });
     validate(cmd: GenerateSyncCommand) { return validateCommand(this.schema, cmd); }
   }
   ```

3. **Create handler** implementing `ICommandHandler<T>`:
   ```typescript
   @CommandHandler(GenerateSyncCommand)
   export class GenerateSyncHandler implements ICommandHandler<GenerateSyncCommand> {
     constructor(
       @Inject(AI_PROVIDER) private readonly provider: AiProvider,
       @InjectPinoLogger(GenerateSyncHandler.name) private readonly logger: PinoLogger,
       private readonly metrics: GenerateMetrics,
     ) {}

     async execute(command: GenerateSyncCommand): Promise<Result<GenerateResponseDto>> {
       const response = await this.provider.generate({ ... });
       this.metrics.requestsTotal.inc({ status: 'success' });
       return Result.success({ ... });
     }
   }
   ```

4. **Register** handler and validator in module's `providers` array

## Rules
- Command class MUST have `@Validate(XxxValidator)` — without it, `.validator.ts` is dead code
- ALL validation in `.validator.ts` using Zod — NEVER validate in handlers
- Handlers NEVER throw exceptions — return `Result.failure()` / `Result.notFound()`
- Return `Result<T>` from handlers — never throw for business errors
- Record metrics in handlers — duration, counts, token usage
