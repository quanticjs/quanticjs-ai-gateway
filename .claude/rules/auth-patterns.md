---
globs: "src/**/*.ts, client/src/**/*.{ts,tsx}"
---

# Authentication & Authorization

All auth is handled by `@quanticjs/auth-web-bff` (backend) and `@quanticjs/react-core` (frontend). Implementation details are in ADR-004, ADR-021, and the framework packages' own rules.

## Permission Model

Permissions use `resource:action` naming (e.g., `cr:create`, `brd:edit`, `estimate:test`). By default they map 1:1 to Keycloak client roles on the client selected via `KEYCLOAK_CLIENT_ID`; the BFF's optional `permissionResolver` hook can override that mapping. Groups in Keycloak assign roles to users — no manual per-user role assignment.

The session includes both `roles[]` (realm roles: `user`, `admin`) and `permissions[]` (client roles: `cr:create`, `brd:edit`, etc.). After login, no runtime Keycloak dependency — the JWT contains everything needed.

`@Permission(a, b)` and `@Roles(a, b)` use **OR semantics** — any one listed permission/role grants access. Method-level decorators override class-level ones (`getAllAndOverride`).

**The `admin` realm role does NOT imply permissions.** Since v7 the hardcoded admin bypass in `PermissionGuard` is removed — a token carrying `roles: ['admin']` with no client roles gets 403 on every `@Permission(...)`-protected route. Admins must be granted the actual client roles in Keycloak, where the grant is visible and auditable. `@Roles('admin')` still works for role-gated (not permission-gated) endpoints.

## Tenant Identity — Verified JWT Only

Tenant identity comes **exclusively from the verified JWT**, never from request headers or bodies:

- `JwtStrategy.validate()` maps `organizationId` from a configurable token claim — `KEYCLOAK_ORG_CLAIM` env var, default `organization_id`. **Keycloak prerequisite:** stock Keycloak does not emit this claim — provision a *User Attribute* protocol mapper (user attribute `organization_id` → token claim, "Add to access token" enabled) on the client scope. Keycloak 26+ Organizations deployments can set `KEYCLOAK_ORG_CLAIM=organization` instead (string claim values only). Without the mapper, `requireCurrentUser().organizationId` is `undefined`.
- **`X-Tenant-ID` is dead.** The server never reads it, it is removed from the CORS allowlist (browsers still sending it fail preflight), and a Jest guard test (`packages/core/src/no-tenant-header.spec.ts`, runs in CI via the core test suite) fails the build if `x-tenant-id` reappears in any package source. (Only `@AllowAnonymous` has dedicated CI greps.) Frontends and API clients must not send it.
- **`TenantContextMiddleware` is deleted.** Remove any `consumer.apply(TenantContextMiddleware)` from `AppModule`. Tenant context is populated by `AuthContextInterceptor`, which nests `tenantStore.run()` inside `executionContextStore.run()` — the user→tenant binding is atomic and happens *after* `JwtAuthGuard`, so it is based on the verified token.
- **JWT audience validation:** `KEYCLOAK_AUDIENCE` is passed to passport-jwt; cross-client tokens are rejected. Requires an *Audience* protocol mapper on the client scope emitting the service's client id. Clock skew tolerance is `clockTolerance: 5` seconds.
- **`KEYCLOAK_CLIENT_ID` populates `permissions[]`** — client roles are read from `resource_access[KEYCLOAK_CLIENT_ID].roles`. If unset, every `@Permission(...)`-gated route returns 403. This is **not** boot-enforced, making it the most likely misconfiguration to check when permissions mysteriously fail.
- **`KEYCLOAK_INTERNAL_URL`:** JWKS keys are fetched from `KEYCLOAK_INTERNAL_URL || KEYCLOAK_URL`, while the issuer check uses the public `KEYCLOAK_URL`. Essential in containers, where the public hostname is not resolvable from inside the network.
- **Production fail-fast:** with `NODE_ENV=production`, boot **throws** if `KEYCLOAK_URL`, `KEYCLOAK_REALM`, or `KEYCLOAK_AUDIENCE` is unset — no silent localhost/default-realm fallback. Dev fallbacks remain with a warning.
- **`TenantSubscriber` trusts only framework-set context** (`tenantStore` → execution-context user's `organizationId` → null). Entity-supplied `organizationId` never selects the RLS tenant: on insert it is stamped from context, and a mismatch **throws**; on update/remove the entity value is ignored. Never accept `organizationId` from request bodies.
- **`TenantSubscriber` operational caveats:** it must be registered per DataSource (`subscribers: [TenantSubscriber]`) — without registration nothing stamps or sets tenant context. Its `set_config(..., true)` is **transaction-local** — outside a transaction it is a silent no-op, so tenant-scoped writes must run inside a transaction. A non-UUID org claim silently produces no tenant context. And when there is no context org at all, an entity-supplied `organizationId` passes through unstamped — RLS is the only defense.
- **Fail-closed without an org claim:** a token with no org claim → `tenantStore` null → no `set_config` → RLS denies tenant-scoped writes. This is correct behavior, not a bug.
- **Cross-tenant system flows** (backfills, migrations) must run via `runAsService()` with a user carrying the target `organizationId`.

## Execution Context — User Identity and CallerType

User identity is **never** passed through command/query constructors. Instead, the `AuthContextInterceptor` (from `@quanticjs/core`) populates an `AsyncLocalStorage`-backed execution context from `req.user` after `JwtAuthGuard` runs, setting `callerType: 'external'`. Handlers read identity from the store:

```typescript
import { requireCurrentUser, getCurrentUser, getCallerType } from '@quanticjs/core';

// In a handler — throws if no user (protected endpoints)
const { userId, email, roles, permissions, organizationId } = requireCurrentUser();
// organizationId requires the Keycloak org-claim mapper — see Tenant Identity above

// When user may be absent (e.g., system-initiated dispatch)
const user = getCurrentUser(); // undefined if no user context

// Check who initiated the call
const callerType = getCallerType(); // 'external' | 'internal' | undefined (no execution context)
```

### CallerType and AuthContextBehavior

The `AuthContextBehavior` (pipeline order 7, after LOG) uses `callerType` to decide auth enforcement. The decision tree is exactly:

| Condition | Behavior |
|---|---|
| `callerType === 'internal'` | **Auto-skips** auth check — system-initiated dispatch via `runAsService()` |
| `callerType === 'external'` + user present | Pass through |
| `callerType === 'external'` + no user | `Result.unauthorized('Authentication required')` |
| No context / no callerType | `Result.unauthorized('No execution context')` |

The two failure messages matter for debugging: `'Authentication required'` means an unauthenticated external request; `'No execution context'` means a dispatch site (lifecycle hook, cron, script) is missing `runAsService()`.

The `AuthContextInterceptor` sets `callerType: 'external'` for all HTTP requests **and binds the tenant store** (see Tenant Identity above) — its global registration is doubly mandatory.

### System-Initiated Dispatch — `runAsService()`

For system-initiated work (timers, cron jobs, batch processing, multi-instance auto-completion), use `runAsService()` to establish an internal execution context. This sets `callerType: 'internal'`, which auto-bypasses `AuthContextBehavior`:

```typescript
import { runAsService } from '@quanticjs/core';

// Timer firing a signal — no user context needed
await runAsService(() =>
  this.commandBus.execute(new SignalProcessCommand(instanceId, signal, undefined, 'timer')),
);

// Optionally attach a user for audit/logging purposes
await runAsService(() =>
  this.commandBus.execute(new SomeCommand(...)),
  user, // optional CurrentUser — available via getCurrentUser() but callerType stays 'internal'
);
```

The counterpart `runWithUser(user, fn)` is also exported — it sets `callerType: 'external'`, i.e. auth IS enforced. Use it when simulating an authenticated external caller (tests, custom transports), not for system work.

### Genuinely Public HTTP Endpoints

`@Public()` (route-level `JwtAuthGuard` skip — for health endpoints, BFF auth endpoints) is **retained** and unrelated to the removed `@AllowAnonymous`. For an endpoint that must execute business logic without authentication:

1. Decorate the **route** with `@Public()` (skips `JwtAuthGuard`).
2. The controller dispatches via `runAsService()` (the command would otherwise fail `AuthContextBehavior`).
3. The team consciously accepts that this endpoint executes unauthenticated business logic — review it as such.

**Service-to-service HTTP calls** never bypass auth: use Keycloak client-credentials tokens, requested with the **target service's audience** (audience validation rejects cross-client tokens).

### Kafka Consumer Context

`KafkaEventConsumer` (from `@quanticjs/events-kafka`) automatically wraps `handleMessage()` with `runAsService(() => this.withInbox(event, () => this.handleMessage(event)), user)` in its `processWithSpan()` method (`withInbox` is the opt-in idempotent-inbox wrapper; the context semantics are unchanged). The user (including `organizationId`) is extracted from the Kafka event envelope; `TenantSubscriber` resolves the tenant from that context user. **Consumers do NOT need manual context setup** — the base class handles it.

Register the interceptor globally in `main.ts`:
```typescript
import { AuthContextInterceptor } from '@quanticjs/core';
app.useGlobalInterceptors(new AuthContextInterceptor());
```

## What To Use

| Need | Use |
|------|-----|
| **Backend — user identity in handlers** | `requireCurrentUser()` / `getCurrentUser()` from `@quanticjs/core` |
| **Backend — tenant identity** | `requireCurrentUser().organizationId` (from the verified JWT claim — never headers/bodies) |
| **Backend — caller type check** | `getCallerType()` from `@quanticjs/core` — returns `'external'`, `'internal'`, or `undefined` (no execution context) |
| **Backend — system-initiated dispatch** | `runAsService(fn, user?)` from `@quanticjs/core` — sets `callerType: 'internal'` |
| **Backend — permission-gated endpoint** | `@Permission('resource:action')` from `@quanticjs/core` |
| **Backend — admin-only endpoint** | `@Roles('admin')` from `@quanticjs/core` (role check only — does NOT grant permissions) |
| **Backend — public route (no JWT)** | `@Public()` on the route + `runAsService()` dispatch in the controller |
| **Backend — global guards** | `JwtAuthGuard`, `RolesGuard`, `PermissionGuard` — the framework exports the classes but does NOT auto-register them; each app must provide all three as `APP_GUARD` providers in its AppModule |
| **Backend — global interceptors** | `AuthContextInterceptor` (register manually in `main.ts`); `ResultInterceptor` is auto-registered by `bootstrapService()` — do not register it again (it would run twice). `GlobalExceptionFilter` is also auto-registered |
| **Backend — BFF module** | `BffModule.forRoot()` from `@quanticjs/auth-web-bff` |
| **Backend — IAM audit** | `IamAuditModule.forRoot({ clients: [...] })` from `@quanticjs/iam-audit` |
| **Backend — service-to-service auth** | Keycloak client-credentials token with the target service's audience |
| API client | `createDefaultClient()` from `@quanticjs/react-core` |
| Session / user info | `useAuth()` from `@quanticjs/react-core` |
| Logout | `useLogout()` from `@quanticjs/react-core` |
| Permission checks (frontend) | `usePermissions()` → `can('brd:edit')` from `@quanticjs/react-core` |
| Declarative permission rendering | `<Can permission="cr:review">` from `@quanticjs/react-core` |
| Route protection (auth) | `AuthGuard` from `@quanticjs/react-core` |
| Route protection (permission) | `<PermissionGuard permission="brd:edit">` from `@quanticjs/react-core` |
| Route protection (admin role) | `<PermissionGuard role="admin">` from `@quanticjs/react-core` |
| IAM audit pages | `IamUsersPage`, `IamGroupsPage`, `IamPermissionMatrixPage` from `@quanticjs/iam-audit-ui` |
| Socket.IO | `io({ withCredentials: true })` |

Permissions are decided on the backend. The frontend is a hint layer, not a security boundary.

## NEVER

- **NEVER** pass `userId`, `keycloakId`, or `req.user` fields as command/query constructor parameters — use `requireCurrentUser()` in the handler instead
- **NEVER** use `@AllowAnonymous()` — originally removed in v6.6.1, it was reintroduced and is **permanently removed in v7.0.0** with a regression guard (Jest guard test + CI grep `! grep -rn "AllowAnonymous" packages/*/src` + an ESLint `no-restricted-syntax` rule that blocks the decorator at lint time). System-initiated dispatch uses `runAsService()`; public HTTP endpoints use `@Public()` + `runAsService()`. Beware: the old decorator's metadata walked the prototype chain, so subclasses inherited the bypass invisibly — another reason it's gone
- **NEVER** read or send the `X-Tenant-ID` header — tenant identity comes only from the verified JWT claim; the header is ignored server-side and removed from the CORS allowlist
- **NEVER** accept `organizationId` from request bodies into entities — `TenantSubscriber` stamps it from context and throws on mismatch
- **NEVER** apply `TenantContextMiddleware` — it is deleted in v7; `AuthContextInterceptor` binds tenancy
- **NEVER** rely on the `admin` realm role to pass `@Permission(...)` checks — the bypass is removed; grant client roles explicitly in Keycloak
- **NEVER** deploy production without `KEYCLOAK_URL`, `KEYCLOAK_REALM`, and `KEYCLOAK_AUDIENCE` set — boot fails fast by design
- **NEVER** manually wrap Kafka consumer `handleMessage()` with `executionContextStore.run()` or `runAsService()` — the base class `KafkaEventConsumer` handles context setup automatically
- **NEVER** store tokens in `localStorage` or `sessionStorage`
- **NEVER** set `Authorization` headers or read token claims from frontend code
- **NEVER** create local auth hooks, guards, logout handlers, or API clients — use the framework
- **NEVER** implement token refresh, 401 retry, or CSRF logic — the framework handles it
- **NEVER** derive permissions from roles on the frontend — they come from `/api/auth/me`
- **NEVER** set cookie attributes in application code — the framework configures these
- **NEVER** use `@Roles()` for feature-gated endpoints — use `@Permission('resource:action')` instead
- **NEVER** use old realm role names (`ba-team`, `strategy-team`, `test-lead`) as permission identifiers — use `resource:action` format
- **NEVER** check `session.roles.includes('role-name')` for feature access — use `can('resource:action')` from `usePermissions()`
