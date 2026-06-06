# Debugging

## Backend (NestJS)

### Logs
```bash
docker compose logs ai-gateway -f --tail=100   # Live structured logs (Pino)
docker compose logs ai-gateway 2>&1 | grep -i error
```

### Health Check
```bash
curl http://localhost:3005/health/live
curl http://localhost:3005/health/ready
```

### Redis
```bash
docker compose exec redis redis-cli PING
docker compose exec redis redis-cli MONITOR
docker compose exec redis redis-cli XINFO GROUPS arex:ai:results
```

### Running Specific Tests
```bash
npx jest --testPathPattern=GenerateSync --verbose
```

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Auth failed (SDK provider) | OAuth token expired | Set `CLAUDE_CODE_OAUTH_TOKEN` env var |
| Anthropic 401 | Invalid API key | Check `ANTHROPIC_API_KEY` env var |
| TEI connection refused | TEI service not running | Check `TEI_URL`, start TEI container |
| Redis connection error | Redis not available | Check `REDIS_URL`, start Redis |
| Circuit breaker open | Provider consecutive failures | Check provider logs, wait for half-open |
| Async result never arrives | Redis down when publishing | Check Redis connection, check stream |

## Quick Diagnostic
```bash
echo "=== Health ===" && curl -s http://localhost:3005/health/ready | jq .
echo "=== Redis ===" && docker compose exec redis redis-cli PING
echo "=== Metrics ===" && curl -s http://localhost:3005/metrics | grep ai_
```
