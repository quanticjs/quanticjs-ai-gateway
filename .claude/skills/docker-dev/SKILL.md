# Docker Dev Environment

## Architecture
```
Backend (NestJS) → Docker Compose (volume-mounted, watch mode)
Frontend (Vite)  → Native on host (NOT in Docker — HMR reliability)
Infrastructure   → Docker internal network (no ports exposed except API + Keycloak)
```

## Commands
| Action | Command |
|--------|---------|
| Start all | `docker compose up` |
| Start with rebuild | `docker compose up --build` |
| Start backend only | `docker compose up backend` |
| View logs | `docker compose logs -f backend` |
| Stop all | `docker compose down` |
| Reset data | `docker compose down -v && docker compose up` |
| Shell into container | `docker compose exec backend sh` |
| Check health | `docker compose ps` |

## Ports (exposed to host)
| Port | Service | Purpose |
|------|---------|---------|
| 3000 | Backend API | Vite proxies `/api/*` and `/auth/*` here |
| 8080 | Keycloak | OIDC browser redirects require direct access |
| 5173 | Vite (native) | Frontend dev server — NOT in Docker |

All other infrastructure (PostgreSQL, Redis, ELK, etc.) stays on Docker's internal network with no host ports.

## Daily Workflow
```bash
# Terminal 1: Backend + infrastructure
docker compose up

# Terminal 2: Frontend (native Vite)
cd client && npm run dev

# Browser: http://localhost:5173
```

## Troubleshooting

### Container won't start
```bash
docker compose logs <service> --tail=50
docker compose ps  # check health status
```

### Database issues
```bash
docker compose exec postgres psql -U postgres -d autoflux
npx typeorm migration:show    # check pending migrations
npx typeorm migration:run     # apply pending
```

### Redis issues
```bash
docker compose exec redis redis-cli PING
docker compose exec redis redis-cli MONITOR  # watch all commands
```

### Port conflicts
```bash
lsof -i :3000  # find what's using the port
docker compose down && docker compose up  # restart clean
```

### Volume mount not syncing
```bash
docker compose restart backend  # force re-read of mounted source
```

## Adding Infrastructure
1. Add service to `docker-compose.yml` with healthcheck
2. Add to backend `depends_on` with `condition: service_healthy`
3. Use Docker hostname in backend config (e.g., `postgres`, `redis`) — NOT `localhost`
4. Do NOT expose port to host unless absolutely required

## Rules
- NEVER run Vite inside Docker — HMR is unreliable with volume mounts
- NEVER expose infrastructure ports to host (except Keycloak for OIDC redirects)
- NEVER hardcode API URLs in frontend — use relative paths (`/api/...`)
- NEVER use `docker compose up` for tests — use `docker-compose.test.yml`
- NEVER run services as root in production images
- Backend uses Docker hostnames (`postgres`, `redis`, `keycloak`) — NOT `localhost`
