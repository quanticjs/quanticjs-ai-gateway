# Debugging

## Backend (NestJS)

### Logs
```bash
docker compose logs backend -f --tail=100   # Live structured logs (Pino)
docker compose logs backend 2>&1 | grep -i error  # Filter errors only
```

### Health Check
```bash
curl http://localhost:3000/health
```

### Database
```bash
docker compose exec postgres psql -U postgres -d autoflux
npx typeorm migration:show       # List migrations and status
npx typeorm migration:run        # Apply pending migrations
npx typeorm migration:revert     # Rollback last migration
```

### Redis (cache/sessions only)
```bash
docker compose exec redis redis-cli PING
docker compose exec redis redis-cli MONITOR          # Watch all commands live
docker compose exec redis redis-cli KEYS '*'         # List all keys
```

### Kafka
```bash
docker compose exec kafka kafka-consumer-groups.sh --bootstrap-server localhost:9092 --list
docker compose exec kafka kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group <groupId>
docker compose exec kafka kafka-topics.sh --bootstrap-server localhost:9092 --list
docker compose exec kafka kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic <topic>.dlq --from-beginning  # Check DLQ
```

### Running specific tests
```bash
npx jest --testPathPattern=CreateItem --verbose
npx jest --watch  # interactive mode
```

## Frontend (React)

### Dev Server
```bash
cd client && npm run dev    # Check terminal for build errors
```

### Browser DevTools
1. **Console** — check for React errors, unhandled rejections
2. **Network** — verify API calls go to `/api/*` (not direct to :3000)
3. **Application > Cookies** — verify httpOnly session cookie exists after login
4. **React DevTools** — inspect component state and query cache
5. **TanStack Query DevTools** — inspect cache state, stale queries, refetch triggers

### Running specific tests
```bash
cd client && npx vitest run src/pages/ProjectsPage.test.tsx
cd client && npx playwright test projects.spec.ts
```

## Common Issues

### Auth / 401 Errors
| Symptom | Cause | Fix |
|---------|-------|-----|
| 401 on every request | Session cookie missing/expired | Re-login via `/auth/login` |
| 401 after refresh | Keycloak session expired | Restart Keycloak: `docker compose restart keycloak` |
| Login redirect loop | Callback URL mismatch | Check Keycloak client config: Valid Redirect URIs |
| No cookie set | Vite proxy not configured | Verify `vite.config.ts` has `/auth` proxy |

### Database / Migrations
| Symptom | Cause | Fix |
|---------|-------|-----|
| `relation does not exist` | Migration not run | `npx typeorm migration:run` |
| `column does not exist` | Entity/migration mismatch | `npx typeorm migration:generate src/migrations/Fix` |
| Migration fails | Conflict with existing data | Check migration SQL, add IF NOT EXISTS |
| Duplicate key error | Missing unique constraint handling | Add `@DistributedLock` or check-before-insert |

### Docker / Services
| Symptom | Cause | Fix |
|---------|-------|-----|
| Connection refused :3000 | Backend not started | `docker compose up backend` |
| Connection refused :5432 | Trying localhost for DB | Use Docker hostname `postgres` in backend config |
| Container restarting | OOM or crash loop | `docker compose logs <svc> --tail=20` |
| Slow hot reload | Volume mount lag | Restart: `docker compose restart backend` |

### Kafka / Events
| Symptom | Cause | Fix |
|---------|-------|-----|
| Consumer lag growing | Consumer crashed or slow | `docker compose exec kafka kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group <groupId>` |
| DLQ filling up | Handler throwing repeatedly | Fix handler bug, then reprocess DLQ topic (`{topic}.dlq`) |
| Cache stale | Missing invalidation | Check mutation's cache invalidation logic |

### Frontend / API
| Symptom | Cause | Fix |
|---------|-------|-----|
| CORS error | Bypassing Vite proxy | Use relative URLs (`/api/...`), not `http://localhost:3000` |
| Stale data | Missing `invalidates` | Add `invalidates: [['queryKey']]` to `useApiMutation` |
| Form errors not showing | Not using `@quanticjs/react-forms` | Use `useForm` — auto-maps server errors |
| White screen | Unhandled error | Check browser console, add ErrorBoundary |

## Quick Diagnostic Script
```bash
echo "=== Services ===" && docker compose ps
echo "=== Backend Health ===" && curl -s http://localhost:3000/health | jq .
echo "=== Pending Migrations ===" && npx typeorm migration:show 2>&1 | grep -v "✓"
echo "=== Redis ===" && docker compose exec redis redis-cli PING
```
