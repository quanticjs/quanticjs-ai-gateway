---
globs: "Dockerfile, docker-compose*.yml"
---

# Docker Patterns

## Architecture: Single Backend Service

One NestJS Docker image — the AI gateway. No frontend.

## Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
RUN npm ci
COPY . .
RUN npx nest build
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3005/health/live || exit 1
CMD ["node", "dist/main"]
```

## Key Port

| Service | Port |
|---------|------|
| AI Gateway | 3005 |

## Environment Variables

| Var | Purpose | Default |
|-----|---------|---------|
| `PORT` | HTTP port | `3005` |
| `REDIS_URL` | Redis connection | `redis://localhost:6379` |
| `AI_PROVIDER` | Provider selection (`claude-sdk` or `anthropic-api`) | `claude-sdk` |
| `AI_MODEL` | Default model | `claude-sonnet-4-5-20250929` |
| `ANTHROPIC_API_KEY` | Anthropic API key (for `anthropic-api` provider) | — |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token (for `claude-sdk` provider) | — |
| `TEI_URL` | Text Embeddings Inference URL | `http://text-embeddings:8080` |

## NEVER

- **NEVER** run services as root in production images — use `USER node`
- **NEVER** copy `node_modules/` into the image — always `npm ci`
- **NEVER** hardcode API keys in Dockerfiles or compose files
- **NEVER** expose TEI or Redis ports to the host in production
