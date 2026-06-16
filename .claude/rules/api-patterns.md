---
globs: "src/**/*.ts"
---

# API Documentation Patterns

## OpenAPI 3.0 — Code-First with @nestjs/swagger

| URL | Purpose |
|-----|---------|
| `<globalPrefix>/docs` | Swagger UI (e.g. `/api/docs` with `bootstrapService({ globalPrefix: 'api' })`; default `/swagger` without a prefix; override via `swaggerPath`) |
| `<path>-json` | OpenAPI 3.0 JSON spec (e.g. `/api/docs-json`) |

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

`ErrorResponseDto` is illustrative — it is not a framework export; define it (or an equivalent) in the app.

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

Unknown error types fall back to 500.

### Production 5xx Masking

In production (`NODE_ENV === 'production'`), `ResultInterceptor` masks any response whose **resolved status is >= 500** (keyed off the status, not just `ErrorType.InternalError` — unknown types falling back to 500 are masked too). Only `detail` is replaced (with `"An unexpected error occurred."`); `type`/`title`/`status`/`instance`/`correlationId` and the `application/problem+json` content type are preserved.

- The full `result.errorMessage` stays server-side (`logger.error` for 5xx — grep logs by `correlationId` to debug).
- **4xx responses keep their detailed `detail` in ALL environments** — do not over-mask validation/not-found/conflict messages.
- Consequence for handlers: **never encode user-facing text in `InternalError`** — it will be masked; user-facing failures belong in 4xx error types.
- Consequence for clients/tests: **never assert on 500 `detail` text** — correlate via `correlationId` + server logs.

### GlobalExceptionFilter (auto-registered by `bootstrapService()`)

Exceptions that escape the Result pipeline are normalized to the same problem-details shape:

- `ThrottlerException` → 429 with `type .../RATE_LIMITED`, body `retryAfter: 60`, plus a `Retry-After` header
- class-validator 400s carry an `errors: [{ message }]` array (a different shape from plain problem details)
- Other `HttpException` → `type .../HTTP_<status>`
- Unhandled exceptions → 500 with the same mask string (`stack` included only in non-prod)

Exceptions thrown inside controllers are converted by `ResultInterceptor` to `Result.failure(InternalError, ...)` — they don't escape as raw 500s.

### Correlation IDs and Validation

- `X-Correlation-ID` is set on **every** response, CORS-exposed, and clients may supply their own (it is echoed back).
- The global `ValidationPipe` is `whitelist: true, forbidNonWhitelisted: true, transform: true` — unknown DTO fields produce a 400, not silent stripping.

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
- **NEVER** put user-facing text in `ErrorType.InternalError` messages — production masks all 5xx `detail` bodies; use 4xx error types for user-facing failures
- **NEVER** assert on 500 response `detail` text in clients or tests — it is environment-dependent; correlate via `correlationId`
