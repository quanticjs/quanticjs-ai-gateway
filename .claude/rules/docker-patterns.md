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

Three `node:20-alpine` stages — see the real `Dockerfile` at the project root for the full version:

- **`development`** (used by docker-compose.yml): `npm ci`, copies `tsconfig*.json nest-cli.json`, `src/` volume-mounted at runtime, `CMD ["npm", "run", "start:dev"]`
- **`builder`**: `npm ci`, copies `src/`, `npm run build` → compiles `dist/` for the production stage
- **`production`**: `ENV NODE_ENV=production`; install via `npm ci --omit=dev --ignore-scripts` then explicit `npm rebuild @confluentinc/kafka-javascript` and `npm cache clean --force`; copies `dist/` from builder; `CMD ["node", "--enable-source-maps", "dist/main.js"]`

Notes:
- `--ignore-scripts` on the production install: supply-chain posture (no arbitrary install scripts) — the explicit allowlisted `npm rebuild` for native deps mirrors the publish pipeline (see `release-engineering.md`).
- `--enable-source-maps`: published `@quanticjs/*` packages ship `.js.map` — stack traces resolve to real source.
- `--omit=dev` is the current spelling (`--only=production` is deprecated).
- `@confluentinc/kafka-javascript` needs its install/rebuild step for prebuilt binaries — and `node:20-alpine` is musl-based, so verify the prebuilds support musl (or switch to a glibc base for Kafka-consuming services).

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
- **NEVER** use `docker compose up` for E2E or integration tests — use `docker compose -f docker-compose.test.yml up` (isolated per-app port band `3N99`/`8N99`/`5N99`, e.g. N=1: `3199`/`8199`/`5199` — see the Per-App Port Band scheme in `testing-integration.md`)
- **NEVER** hardcode API URLs in frontend — use relative paths (`/api/items`)
- **NEVER** use Docker Compose short hostnames in Helm values
- **NEVER** mount host `node_modules` into Kubernetes pods
- **NEVER** use local K8s for daily feature development — use Docker Compose
