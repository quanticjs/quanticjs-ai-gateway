---
globs: "Dockerfile, client/Dockerfile, docker-compose*.yml, scripts/**"
---

# Docker Patterns

## Local Dev Uses Docker Compose (Internal Network)

```bash
# Daily development
docker compose up                        # Start infra + backend (watch mode)
cd client && npm run dev                 # Start Vite natively (separate terminal)
```

## Architecture: Modular Monolith — Two Dockerfiles

| Service | Dockerfile | What it builds |
|---------|-----------|----------------|
| Backend (NestJS) | `Dockerfile` (project root) | All backend modules in one image |
| Frontend (React) | `client/Dockerfile` | Vite build → nginx (K8s only) |

## docker-compose.yml Design

- **Only `backend` and `keycloak` have `ports:` sections** (3000, 8080)
- **Backend uses Docker hostnames** (`postgres`, `redis`, `keycloak`) — NOT `localhost`
- **Source code is volume-mounted** (`./src:/app/src:cached`)
- **Keycloak uses dev-mem mode** for fast startup
- **Database init** handled by `scripts/init-db.sh`

## Backend Dockerfile (multi-stage)

```dockerfile
# Development target — used by docker-compose.yml
FROM node:20-alpine AS development
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
# src/ volume-mounted at runtime
CMD ["npm", "run", "start:dev"]

# Production target
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/main.js"]
```

## Vite Proxy Configuration (critical for BFF auth)

```typescript
// client/vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/auth': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
```

## Kubernetes (Integration Testing Only)

```bash
scripts/local-dev-up.sh           # Create Kind cluster + deploy
scripts/helm-deploy-local.sh      # Re-deploy after Helm changes
```

Use Helm release-prefixed service names, not Docker Compose short names.

## NEVER

- **NEVER** expose infrastructure ports to the host (except Keycloak 8080 for OIDC redirects)
- **NEVER** run Vite inside Docker — HMR is unreliable with volume mounts
- **NEVER** create per-service Dockerfiles — this is a monolith
- **NEVER** run services as root in production images
- **NEVER** copy `node_modules/` into the image — always `npm ci`
- **NEVER** use `docker compose up` for E2E or integration tests — use `docker compose -f docker-compose.test.yml up` (isolated ports: API 3099, Keycloak 8099, Frontend 5199)
- **NEVER** hardcode API URLs in frontend — use relative paths (`/api/items`)
- **NEVER** use Docker Compose short hostnames in Helm values
- **NEVER** mount host `node_modules` into Kubernetes pods
- **NEVER** use local K8s for daily feature development — use Docker Compose
