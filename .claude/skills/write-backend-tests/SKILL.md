# Write Tests — Backend

## Usage
```
/write-backend-tests src/project/commands/CreateItemHandler.ts
/write-backend-tests src/project/controllers/ItemsController.ts
```

## 1. Handler Unit Test (`*.spec.ts`)

Test the handler directly — mock repositories, assert `Result<T>`.

```typescript
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createMockRepository, ErrorType } from '@quanticjs/core';
import { CreateItemHandler } from './CreateItemHandler';
import { CreateItemCommand } from './CreateItemCommand';
import { Item } from '../entities/Item.entity';

describe('CreateItemHandler', () => {
  let handler: CreateItemHandler;
  let itemRepo: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    itemRepo = createMockRepository();
    itemRepo.create.mockImplementation((dto: any) => ({
      ...dto,
      id: 'item-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    itemRepo.save.mockImplementation((entity: any) => Promise.resolve(entity));

    const module = await Test.createTestingModule({
      providers: [
        CreateItemHandler,
        { provide: getRepositoryToken(Item), useValue: itemRepo },
      ],
    }).compile();

    handler = module.get(CreateItemHandler);
  });

  it('should create item and return success', async () => {
    const command = new CreateItemCommand({ name: 'Widget', userId: 'user-1' });
    const result = await handler.execute(command);

    expect(result.isSuccess).toBe(true);
    expect(result.value!.name).toBe('Widget');
    expect(itemRepo.save).toHaveBeenCalledTimes(1);
  });

  it('should return conflict when name already exists', async () => {
    itemRepo.findOne.mockResolvedValue({ id: 'existing', name: 'Widget' });
    const command = new CreateItemCommand({ name: 'Widget', userId: 'user-1' });
    const result = await handler.execute(command);

    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.Conflict);
    expect(itemRepo.save).not.toHaveBeenCalled();
  });
});
```

### Key Rules
- Use `createMockRepository()` from `@quanticjs/core` — never hand-roll mocks
- Override specific methods with `.mockImplementation()` for test scenarios
- Assert via `result.isSuccess`, `result.value`, `result.errorType` — never try/catch
- Test both success AND failure paths (NotFound, Conflict, Forbidden, ValidationError)

## 2. Controller Integration Test (`*.spec.ts`)

Test HTTP request → validation → bus dispatch → response. Mock CommandBus/QueryBus.

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import { Result } from '@quanticjs/core';
import { ItemsController } from './ItemsController';

class MockAuthGuard {
  canActivate(context: any) {
    const req = context.switchToHttp().getRequest();
    req.user = {
      keycloakId: 'user-1',
      email: 'test@test.com',
      roles: ['admin'],
    };
    return true;
  }
}

describe('ItemsController (integration)', () => {
  let app: INestApplication;
  let commandBus: { execute: jest.Mock };
  let queryBus: { execute: jest.Mock };

  beforeAll(async () => {
    commandBus = { execute: jest.fn() };
    queryBus = { execute: jest.fn() };

    const module = await Test.createTestingModule({
      controllers: [ItemsController],
      providers: [
        { provide: CommandBus, useValue: commandBus },
        { provide: QueryBus, useValue: queryBus },
        { provide: APP_GUARD, useClass: MockAuthGuard },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }));
    await app.init();
  });

  afterAll(() => app.close());

  it('should create item with valid payload', async () => {
    commandBus.execute.mockResolvedValue(Result.success({ id: 'item-1' }));

    const res = await request(app.getHttpServer())
      .post('/api/items')
      .send({ name: 'Widget', description: 'A widget' });

    expect(res.status).toBe(201);
    expect(commandBus.execute).toHaveBeenCalledTimes(1);
  });

  it('should reject invalid payload', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/items')
      .send({});

    expect(res.status).toBe(400);
    expect(commandBus.execute).not.toHaveBeenCalled();
  });
});
```

### Key Rules
- MockAuthGuard sets `req.user` with `keycloakId`, `email`, `roles`
- ValidationPipe with `whitelist + forbidNonWhitelisted` — tests class-validator DTOs
- Mock CommandBus/QueryBus return `Result.success()` or `Result.failure()`
- Test validation (400), auth (401/403), success (200/201), and not-found (404) cases
- Use `beforeAll` / `afterAll` for app lifecycle (not beforeEach — too slow)

## 3. Validator Unit Test (`*.spec.ts`)

```typescript
describe('CreateItemValidator', () => {
  const validator = new CreateItemValidator();

  it('should pass with valid input', () => {
    const result = validator.validate(new CreateItemCommand({ name: 'Valid' }));
    expect(result.isSuccess).toBe(true);
  });

  it('should fail when name is empty', () => {
    const result = validator.validate(new CreateItemCommand({ name: '' }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });
});
```

## Test File Naming
| Type | Pattern | Location |
|------|---------|----------|
| Handler unit | `CreateItemHandler.spec.ts` | Next to handler file |
| Validator unit | `CreateItemValidator.spec.ts` | Next to validator file |
| Controller integration | `ItemsController.spec.ts` | Next to controller file |

## Mandatory Coverage
Every handler test must cover: happy path, validation failure, not found, conflict, permission check.
