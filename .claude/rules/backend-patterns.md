---
globs: "src/**/*.ts"
---

# Backend Patterns

## Service Architecture

Single deployable NestJS backend image — the central AI gateway service. No frontend.

### Module Structure

```
src/
  <module>/           # Domain module (e.g., generate, embed)
```

### Module Boundary Rules

- Modules communicate through `CommandBus`/`QueryBus` — never import another module's services or repositories
- Async inter-module communication uses Redis Streams
- Only commands, queries, and DTOs are exported from a module

## POST-IMPLEMENTATION CHECKLIST (run after every command/handler pair)

Before committing any command + handler:
- [ ] Command class has `@Validate(XxxValidator)` decorator → grep the command file for `@Validate`
- [ ] `.validator.ts` file exists with Zod schema + `ICommandValidator<T>`
- [ ] Controller only injects `CommandBus`/`QueryBus` — no services, no repositories

## Controller Pattern (MANDATORY — thin controllers)

Controllers ONLY parse the request and dispatch to command/query bus. No services, no repositories, no business logic.

```typescript
import { Controller, Post, Body } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

@Controller('generate')
export class GenerateController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post('sync')
  async generateSync(@Body() dto: GenerateRequestDto) {
    return this.commandBus.execute(
      new GenerateSyncCommand(dto.systemPrompt, dto.userPrompt, dto.maxTokens, dto.model, dto.jsonSchema, dto.purpose, dto.callerService),
    );
  }
}
```

## CQRS Handler Pattern

Every feature is a **Command class + CommandHandler** pair. Controllers are thin — they only
parse the request and dispatch to the command/query bus.

```typescript
import { Validate } from '@quanticjs/core';
import { Result, ErrorType } from '@quanticjs/core';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

// Command class — MUST have @Validate decorator
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

// Handler — NO validation logic in handlers
@CommandHandler(GenerateSyncCommand)
export class GenerateSyncHandler implements ICommandHandler<GenerateSyncCommand> {
  constructor(@Inject(AI_PROVIDER) private readonly provider: AiProvider) {}
  async execute(command: GenerateSyncCommand): Promise<Result<GenerateResponseDto>> {
    const response = await this.provider.generate({ ... });
    return Result.success({ ... });
  }
}
```

## Validation Pattern (MANDATORY)

**Two layers — never mix them:**

| Layer | Tool | Where |
|-------|------|-------|
| DTO (controller) | class-validator decorators | `*.dto.ts` |
| Command (pipeline) | Zod + `@Validate(ValidatorClass)` | `*.validator.ts` |

**CRITICAL:** Creating a `.validator.ts` file is NOT enough. The command class MUST have `@Validate(XxxValidator)` decorator or the validator never executes.

**Handlers MUST NOT contain validation logic.** No `if (x) return Result.failure(...)` in handlers. ALL business rule validation belongs in the Zod validator.

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

## Result<T> Usage

Handlers return `Result<T>` — never throw for business errors.

```typescript
Result.success(value)                              // happy path
Result.failure(ErrorType.NotFound, 'message')      // typed error
Result.failure(ErrorType.InternalError, 'message') // internal error
```

## Provider Pattern

External AI backends are wrapped in providers behind interfaces with Symbol tokens:

```typescript
export interface AiProvider {
  readonly name: string;
  generate(request: AiGenerateRequest): Promise<AiGenerateResponse>;
}
export const AI_PROVIDER = Symbol('AI_PROVIDER');

// Module registration:
{ provide: AI_PROVIDER, useExisting: SdkProvider }
// or with factory:
{ provide: AI_PROVIDER, useFactory: (config, sdk, anthropic) => ... }
```

## NestJS Module Patterns

### .forRoot() Modules — Import ONCE in app.module.ts

Modules with `.forRoot()` MUST be imported **exactly once** in `app.module.ts`. Feature modules import the regular module (no `.forRoot()`).

### Lifecycle Hooks

**`onModuleInit()`** — for synchronous setup.
**`onApplicationBootstrap()`** — for starting async work (polling loops).

### Graceful Shutdown

Handled by `QuanticHealthModule` with `shutdownAware: true` and `shutdownDelayMs: 5_000`.

## NEVER

- **NEVER** inject services or repositories into controllers — dispatch to the bus only
- **NEVER** put business logic in controllers
- **NEVER** put validation logic in handlers — use `@Validate` + `.validator.ts`
- **NEVER** use Joi, Yup, or other validation libraries — class-validator for DTOs, Zod for commands
- **NEVER** create a `.validator.ts` file without `@Validate(XxxValidator)` on the command class
- **NEVER** throw `HttpException` from handlers — return `Result<T>`
- **NEVER** use `Result.validationError()` in handlers
- **NEVER** import `.forRoot()` modules in feature modules
- **NEVER** start blocking poll loops in `onModuleInit()` — use `onApplicationBootstrap()`
- **NEVER** share Redis connection for blocking XREADGROUP reads
- **NEVER** use `redis.disconnect()` in shutdown logic — use `redis.quit()`
