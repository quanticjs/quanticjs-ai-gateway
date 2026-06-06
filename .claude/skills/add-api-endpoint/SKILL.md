# Add API Endpoint

Wire a CQRS handler to an HTTP endpoint with DTO validation and a thin controller.

## Usage
```
/add-api-endpoint POST /project/items
/add-api-endpoint GET /identity/users/:id
```

## Steps
1. **Create handler** — run `/add-handler` for the command/query + validator + handler
2. **Create DTO** with class-validator decorators (controller-layer validation):
   ```typescript
   import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
   import { ApiProperty } from '@nestjs/swagger';

   export class CreateItemDto {
     @ApiProperty({ description: 'Item name', minLength: 1, maxLength: 100 })
     @IsString()
     @IsNotEmpty()
     @MaxLength(100)
     name: string;
   }
   ```
3. **Create response DTO:**
   ```typescript
   export class ItemResponseDto {
     @ApiProperty()
     id: string;

     @ApiProperty()
     name: string;

     @ApiProperty()
     createdAt: Date;
   }
   ```
4. **Add controller method** — THIN pattern:
   ```typescript
   @Post()
   @ApiOperation({ summary: 'Create a new item' })
   @ApiResponse({ status: 201, type: ItemResponseDto })
   @ApiResponse({ status: 400, type: ErrorResponseDto })
   async create(@Body() dto: CreateItemDto): Promise<ItemResponseDto> {
     return this.commandBus.execute(new CreateItemCommand(dto.name, dto.description));
   }
   ```
5. Register handler in module's `providers` array (if not done in step 1)
6. **Add backend tests** — run `/write-backend-tests` for handler, validator, and controller
7. `npm run build && npm run test`

## Rules
- Controller does NOTHING except parse request → commandBus/queryBus → return
- DTO uses class-validator for shape validation; business rules stay in the Zod validator (created by `/add-handler`)
- ALL repo access via `getTransactionalRepo()` — UnitOfWork is automatic
- Every endpoint annotated with `@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiTags`
- All API responses use typed response DTOs — never raw entity objects
- Error responses use RFC 9457 problem-details shape
