# AI Gateway

## Stack

- **Backend:** NestJS, CQRS with `@quanticjs/core`, Redis, Prometheus metrics, OpenTelemetry tracing
- **AI Providers:** Claude SDK (`@anthropic-ai/claude-agent-sdk`), Anthropic API (direct HTTP)
- **Embedding:** TEI (Text Embeddings Inference) via HTTP
- **Infrastructure:** Docker, Kubernetes + Helm

## Architecture

**Central AI gateway service.** All AI operations (text generation, embeddings) flow through this single service. Callers never talk to AI backends directly.

**CQRS.** Every operation is a Command class + Handler. Controllers are thin — they only parse requests and dispatch to the bus.

**Provider abstraction.** AI backends implement `AiProvider` / `EmbeddingProvider` interfaces behind Symbol tokens (`AI_PROVIDER`, `EMBEDDING_PROVIDER`). New providers plug in without changing handlers or controllers.

## Key Conventions

- Handlers return `Result<T>` — never throw for business errors
- Validation: DTOs use class-validator, Commands use Zod via `@Validate`
- Every external HTTP call has a circuit breaker (`createCircuitBreaker()`)
- Every external HTTP call has an `AbortController` timeout
- Metrics recorded in handlers: duration, tokens, cost, circuit breaker state
- `callerService` field on all requests for tracking which service is calling

## Ports

| Service | Port |
|---------|------|
| AI Gateway | 3005 |

## API Routes

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/generate/sync` | Synchronous AI generation |
| `POST` | `/generate` | Async AI generation (returns requestId, publishes to Redis stream) |
| `POST` | `/embed` | Batch text embedding |
| `POST` | `/embed/single` | Single text embedding |
| `GET` | `/health/live` | Liveness probe |
| `GET` | `/health/ready` | Readiness probe |

## Environment Variables

| Var | Purpose | Default |
|-----|---------|---------|
| `PORT` | HTTP port | `3005` |
| `REDIS_URL` | Redis connection | `redis://localhost:6379` |
| `AI_PROVIDER` | Provider selection | `claude-sdk` |
| `AI_MODEL` | Default model | `claude-sonnet-4-5-20250929` |
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token for SDK | — |
| `TEI_URL` | TEI service URL | `http://text-embeddings:8080` |

## Skill Routing

| When you need to... | Use |
|---|---|
| Add a command/query + validator + handler | `/add-handler` |
| Create a new domain module | `/add-module` |
| Wire a handler to an HTTP endpoint | `/add-api-endpoint` |
| Add a new AI provider (OpenAI, Gemini, etc.) | `/add-integration` |
| Add Redis stream events | `/add-event` |
| Write backend tests | `/write-backend-tests` |
| Run the test suite | `/run-tests` |
| Fix a bug (TDD workflow) | `/fix-bug` |
| Review code before merge | `/review-code` |
| Debug a failing service | `/debugging` |
| Manage Docker dev environment | `/docker-dev` |

## Test Commands

```bash
# Build
npm run build

# All tests
npm test

# Specific test
npx jest --testPathPattern=<pattern>
```
