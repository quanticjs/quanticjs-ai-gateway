---
globs: "src/**/*.ts"
---

# API Documentation Patterns

## OpenAPI 3.1 — Code-First with @nestjs/swagger

## Controller Decorators (MANDATORY)

Every endpoint annotated with `@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiTags`.

```typescript
@ApiTags('generate')
@Controller('generate')
export class GenerateController {
  @Post('sync')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate AI response (synchronous)' })
  @ApiResponse({ status: 200, description: 'AI response generated' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async generateSync(@Body() dto: GenerateRequestDto) { ... }
}
```

## DTO Decorators

DTOs use both `class-validator` (runtime) and `@ApiProperty` (docs):

```typescript
export class GenerateRequestDto {
  @ApiProperty({ description: 'System prompt for the AI model' })
  @IsString()
  @MaxLength(100_000)
  systemPrompt!: string;
}
```

## Response DTOs

All API responses use typed response DTOs — never raw objects.

## Result<T> → HTTP Mapping

| Result | HTTP |
|--------|------|
| `Result.success(value)` | 200/201/202 |
| `ErrorType.ValidationError` | 400 |
| `ErrorType.NotFound` | 404 |
| `ErrorType.InternalError` | 500 |

## NEVER

- **NEVER** return raw objects from controllers — use response DTOs
- **NEVER** leave endpoints undocumented
