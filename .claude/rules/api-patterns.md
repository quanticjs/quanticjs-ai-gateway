---
globs: "src/**/*.ts"
---

# API Documentation Patterns

## OpenAPI 3.1 — Code-First with @nestjs/swagger

| URL | Purpose |
|-----|---------|
| `/api/docs` | Swagger UI (interactive) |
| `/api/docs-json` | OpenAPI 3.1 JSON spec |

## Controller Decorators (MANDATORY)

Every endpoint annotated with `@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiTags`.

```typescript
@ApiTags('items')
@Controller('items')
export class ItemsController {
  @Post()
  @ApiOperation({ summary: 'Create a new item' })
  @ApiResponse({ status: 201, type: ItemResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  create(@Body() dto: CreateItemDto) { ... }
}
```

## DTO Decorators

DTOs use both `class-validator` (runtime) and `@ApiProperty` (docs):

```typescript
export class CreateItemDto {
  @ApiProperty({ description: 'Item name', minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;
}
```

## Response DTOs

All API responses use typed response DTOs — never raw entity objects.

## Result<T> → HTTP Mapping (RFC 9457 Problem Details)

Error responses use `Content-Type: application/problem+json` with RFC 9457 problem-details shape:

```json
{
  "type": "https://quantic.dev/errors/NOT_FOUND",
  "title": "Not Found",
  "status": 404,
  "detail": "Item not found",
  "instance": "/api/items/123",
  "correlationId": "abc-123"
}
```

| Result | HTTP |
|--------|------|
| `Result.success(value)` | 200/201 |
| `ErrorType.ValidationError` | 400 |
| `ErrorType.Unauthorized` | 401 |
| `ErrorType.Forbidden` | 403 |
| `ErrorType.NotFound` | 404 |
| `ErrorType.Conflict` | 409 |
| `ErrorType.UnprocessableEntity` | 422 |
| `ErrorType.InternalError` | 500 |

## Environment Availability

| Env | Swagger UI | JSON Spec |
|-----|-----------|-----------|
| Local / Dev / Staging | Enabled | Enabled |
| **Production** | **Disabled** | **Disabled** |

## NEVER

- **NEVER** maintain separate Markdown/Wiki API documentation
- **NEVER** return raw entities from controllers — use response DTOs
- **NEVER** leave endpoints undocumented
- **NEVER** enable Swagger UI in production
