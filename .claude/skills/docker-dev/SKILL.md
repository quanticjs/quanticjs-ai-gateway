# Docker Dev

## Architecture
AI Gateway runs in Docker with Redis and TEI as dependencies.

## Commands
```bash
docker compose up                    # Start all services
docker compose up --build            # Rebuild and start
docker compose logs ai-gateway -f    # Follow logs
docker compose down                  # Stop all
docker compose restart ai-gateway    # Restart gateway only
docker compose exec ai-gateway sh    # Shell into container
```

## Ports
| Service | Port |
|---------|------|
| AI Gateway | 3005 |

## Health Check
```bash
curl http://localhost:3005/health/live
curl http://localhost:3005/health/ready
```

## Troubleshooting
| Issue | Fix |
|-------|-----|
| Container won't start | Check logs: `docker compose logs ai-gateway --tail=20` |
| Redis connection refused | Ensure Redis is running: `docker compose up redis` |
| TEI connection refused | Ensure TEI is running, check `TEI_URL` env var |
| Port conflict | Check `docker ps`, kill conflicting process |

## Rules
- NEVER run services as root — use `USER node` in Dockerfile
- NEVER hardcode API keys in docker-compose files — use env vars
- NEVER expose Redis/TEI ports to host in production
