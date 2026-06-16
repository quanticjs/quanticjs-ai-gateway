---
globs: "client/src/**/*.{ts,tsx}"
---

# Frontend Observability

## Sentry — Error Tracking + Performance

```typescript
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration({ maskAllText: true })],
  tracesSampleRate: import.meta.env.VITE_ENV === 'production' ? 0.1 : 1.0,
  replaysOnErrorSampleRate: 1.0,
});
```

## Environment Configuration

| Environment | Error tracking | Performance sampling | Session replay |
|---|---|---|---|
| Local dev | Disabled | Disabled | Disabled |
| Dev / Staging | All errors | 100% | On error only |
| Production | All errors | 10% | On error only |

## Alert Triage

Unresolved Sentry issues must be triaged within 48 hours — assign an owner or mark as expected behavior.

## Web Vitals

LCP < 2.5s, INP < 200ms, CLS < 0.1. JS bundle < 200KB gzipped.

## Backend Correlation

Every API request carries an `X-Correlation-ID` header, attached automatically by the framework client (`createDefaultClient()` includes the `correlationId()` interceptor). Never hand-roll a correlation interceptor or use `x-request-id` — on API failure, read `ApiError.correlationId` and include it in Sentry reports for backend log lookup.

## NEVER

- **NEVER** use `console.log` in application code — use Sentry
- **NEVER** include monitoring tools (pino-pretty, debug transports) in production frontend bundles
- **NEVER** log PII to Sentry
