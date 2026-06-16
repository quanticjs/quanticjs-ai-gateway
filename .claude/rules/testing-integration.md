---
globs: "**/*.integration-spec.ts, src/test/integration-harness.ts, client/e2e/integration/**/*.ts, client/playwright.integration.config.ts, jest.config.integration.js, docker-compose.test.yml"
---

# Testing — Integration (Real Backend, Real DB, Real Auth)

Integration tests verify that system boundaries work correctly: database constraints, authentication flows, API contracts, cross-module communication, and transaction behavior. They hit real PostgreSQL, real Redis, and real Keycloak — no mocks for services you own.

This is the complement to `testing-e2e-ui.md` (mock-based UI state testing). The two suites serve different purposes and must not be mixed.

## When Integration vs Mock

| Write an **integration test** when... | Write a **mock E2E test** when... |
|---|---|
| Testing a cross-module flow (cart → order → workflow) | Testing that a page renders all 5 UI states correctly |
| Verifying DB constraints (unique slug, cascade delete, enum validation) | Testing form validation edge cases in the UI |
| Verifying auth boundary behavior (BFF cookies, CSRF, permission denial) | Testing loading/error/empty/recovery states |
| Testing API contract shape (real response shape matches frontend expectations) | Testing responsive layout rendering |
| Verifying transaction rollback on partial failure | Testing UI component interactions in isolation |
| Testing Redis-based features (distributed locks, pub/sub, session) | Testing that a mutation error shows a toast |
| Verifying cross-module events via Kafka (mock the Kafka *client driver* at this layer; a real Kafka broker belongs to E2E. Redis via Testcontainers IS used at this layer — see `@quanticjs/events-redis`'s Redis Streams suite) | Testing accessibility (WCAG 2.2 AA) |

**Principle:** Mock what you don't control, test what you do (Kent C. Dodds). QuanticJS apps own — and run locally in their hermetic test stack (`docker-compose.test.yml`) — PostgreSQL, Redis, Keycloak, and the platform's own services: **QuanticFlow, the File Service, the Notification Engine, and the AI Gateway's local embedding model**. All of these run **REAL** in integration tests by default. The only **genuinely external** dependencies are **Anthropic** (paid, rate-limited, non-deterministic — reached *through* the AI Gateway) and third-party APIs such as **GitHub**. Those are stubbed, and guarded against drift by a scheduled contract canary (see "Mock-Drift Contract Canary" below). A consumer app records its concrete dependency classification in a project-local rule (e.g. `testing-external-deps.md`).

**Selection criterion:** The left column lists boundaries where mocking creates a fidelity gap — where a mock hides failures that would break in production (Google SWE book: "The primary reason larger tests exist is to address fidelity"). The right column lists things where mock-based testing provides sufficient confidence.

## Two Integration Test Types

### Backend Integration Tests (`*.integration-spec.ts`)

Full HTTP round trip: Request → Controller → Pipeline → Handler → Real Database.

**Location:** framework packages: `test/` at package root; consumer apps may co-locate (with their own glob discipline)
**Runner:** Jest with `jest.config.integration.js` (testRegex `.*\.integration-spec\.ts$`, `roots: ['<rootDir>/test']`, coverage thresholds cleared — integration is not a coverage gate)
**Command:** `npm run test:integration` — runs as its **own task in CI** (after build/lint/`test:cov`) and is a **publish gate** in the release pipeline (see `release-engineering.md`)

> Naming: `*.integration-spec.ts` in a `test/` directory at the package root is the canonical pattern for **framework packages** (matches Nest's `*.e2e-spec.ts` convention and stays out of the unit `testRegex '.*\.spec\.ts$'`).
>
> **Consumer apps** that co-locate integration specs as `*.integration.spec.ts` (alongside the module) MUST apply the matching **glob discipline**: exclude them from the unit/base Jest config with `testPathIgnorePatterns: ['\\.integration\\.spec\\.ts$']`, and **override `testPathIgnorePatterns` back to `['/node_modules/']` in the integration config** (which extends the base) so it still discovers them. Without the base exclusion, the base regex `.*\.spec\.ts$` matches `*.integration.spec.ts` and runs Docker-dependent tests in every plain `npm test`. Either approach (hyphen naming OR base-config exclusion) is acceptable; pick one and apply it consistently.

```typescript
import { createIntegrationHarness, truncateAllTables } from '../test/integration-harness';
import { OrderModule } from './order.module';

describe('OrderModule (integration)', () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      modules: [OrderModule],
      // app-integration isolation + external deps — array of { token, useValue }; see "Two integration layers"
      mockExternals: [{ token: AI_PROVIDER, useValue: mockAiProvider }],
    });
  });

  afterEach(() => truncateAllTables(harness.dataSource));
  afterAll(() => harness.close());

  it('POST /api/orders creates order in database', async () => {
    const res = await harness.request()
      .post('/api/orders')
      .set('Cookie', harness.authCookies.admin)
      .send({ name: 'Test Order', category: 'standard', priority: 'Medium' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');

    const row = await harness.dataSource.query(
      `SELECT * FROM sales.orders WHERE id = $1`, [res.body.id],
    );
    expect(row).toHaveLength(1);
    expect(row[0].name).toBe('Test Order');
  });

  it('rejects duplicate slug with 409', async () => {
    await harness.request()
      .post('/api/orders')
      .set('Cookie', harness.authCookies.admin)
      .send({ name: 'Duplicate', category: 'standard', priority: 'Medium' });

    const res = await harness.request()
      .post('/api/orders')
      .set('Cookie', harness.authCookies.admin)
      .send({ name: 'Duplicate', category: 'standard', priority: 'Medium' });

    expect(res.status).toBe(409);
  });

  it('returns 403 when user lacks permission', async () => {
    const res = await harness.request()
      .post('/api/orders')
      .set('Cookie', harness.authCookies.viewer)
      .send({ name: 'Forbidden', category: 'standard', priority: 'Medium' });

    expect(res.status).toBe(403);
  });
});
```

### Frontend Integration E2E Tests (`client/e2e/integration/*.spec.ts`)

Browser-driven tests against the real running stack. NO `page.route()` — all API calls hit the real backend.

**Location:** `client/e2e/integration/`
**Runner:** Playwright with `playwright.integration.config.ts`
**Command:** `cd client && npx playwright test --config playwright.integration.config.ts`

```typescript
import { test, expect, TEST_USERS } from './fixtures';

test.describe.configure({ mode: 'serial' });

test.describe('Cart to Order Journey', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Integration tests run on chromium only');

  let cartId: string;
  let orderId: string;

  test('creates a new cart via the UI', async ({ page }) => {
    await page.goto('/carts/new');
    await page.getByLabel(/item name/i).fill('Integration test item');
    await page.getByRole('button', { name: /create cart/i }).click();

    await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible();
    cartId = page.url().split('/carts/')[1];
    expect(cartId).toBeTruthy();
  });

  test('order appears on dashboard after confirmation', async ({ page }) => {
    // ... confirm cart, verify order created
    await page.goto('/');
    await expect(page.getByText('Integration test order')).toBeVisible();
  });
});
```

## Test Data Strategy

### API-Based Seeding (preferred for frontend integration tests)

Seed data by calling the real API before navigating. This validates the API as a side effect.

```typescript
import { createApiContext } from './fixtures';

test.describe('Order Detail Journey', () => {
  let apiContext: APIRequestContext;
  let orderId: string;

  test.beforeAll(async ({ playwright }) => {
    apiContext = await createApiContext(playwright);
    const res = await apiContext.post('/api/orders', {
      data: { name: 'Seeded Order', category: 'standard', priority: 'High' },
    });
    orderId = (await res.json()).id;
  });

  test.afterAll(async () => {
    await apiContext.dispose();
  });

  test('shows order detail with real data', async ({ page }) => {
    await page.goto(`/orders/${orderId}`);
    await expect(page.getByRole('heading', { name: 'Seeded Order' })).toBeVisible();
  });
});
```

### Direct DB Seeding (for backend integration tests)

Use TypeORM repositories directly when testing the API itself or when API seeding would be circular.

```typescript
const orderRepo = harness.dataSource.getRepository(Order);
const order = orderRepo.create({
  name: 'Seed Order',
  slug: 'seed-order',
  category: 'standard',
  priority: 'High',
  createdBy: 'admin-keycloak-id',
});
await orderRepo.save(order);
```

## Database Cleanup

**Backend tests:** `truncateAllTables(harness.dataSource)` in `afterEach`. Truncates all application schemas (`order`, `cart`, `document`, `notification`, `ai_gateway`, `workflow_engine`) with `CASCADE`.

**Frontend tests:** `global-teardown.ts` runs after all specs. Individual test suites that need clean state should seed their own data in `beforeAll` — don't rely on data from other suites.

```typescript
async function truncateAllTables(dataSource: DataSource): Promise<void> {
  const schemas = ['sales', 'cart', 'document', 'notification', 'ai_gateway', 'workflow_engine'];
  for (const schema of schemas) {
    const tables = await dataSource.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1`, [schema],
    );
    if (tables.length) {
      const tableNames = tables.map((t: { tablename: string }) =>
        `"${schema}"."${t.tablename}"`
      ).join(', ');
      await dataSource.query(`TRUNCATE ${tableNames} CASCADE`);
    }
  }
}
```

## What to Mock

| Service | Treatment | Why |
|---|---|---|
| PostgreSQL | **REAL** | We own it — test constraints, transactions, queries |
| Redis | **REAL** | We own it — test distributed locks, sessions, pub/sub |
| Keycloak | **REAL**¹ | We own it — test auth flows, token exchange, permissions |
| Kafka | **REAL** | We own it — test cross-module events, consumer side-effects, ordering |
| QuanticFlow | **REAL** at the workflow-process layer; **MOCK** the `WorkflowClientService` at the app-integration layer | Two layers (see below). BPMN routing is exercised real in the dedicated workflow-process spec. App-level harness suites mock the workflow client because the real-engine round-trip is covered there, not per app test. |
| File Service | **REAL** | Owned platform service (MinIO + Solr backed) in the hermetic stack |
| Notification Engine | **REAL** | Owned, in the hermetic stack |
| AI Gateway — embeddings (TEI) | **REAL** | Local model in the stack — cheap and deterministic enough; no external call |
| AI Gateway → **Anthropic** | **MOCK** | Genuinely external — expensive, rate-limited, non-deterministic. Golden fixtures / HAR + scheduled contract canary |
| Third-party APIs (e.g. **GitHub**) | **MOCK** | Genuinely external — rate-limited, unrunnable locally. Mock + contract canary |

¹ At the **framework** integration layer, Keycloak is stubbed in-process; "real Keycloak" applies to consumer-app suites (e.g. your-app).

### Two integration layers

| Layer | Stack | Treatment of QuanticFlow / Kafka |
|---|---|---|
| **App integration** (`createIntegrationHarness`, real DB) | Real PG/Redis/Keycloak; app under test in-process | **Mock** `WorkflowClientService` and `KafkaEventPublisher` — the app's own logic + DB is under test, not the engine. The real engine round-trip is covered by the workflow-process layer, so paying for it per app test is wasteful. |
| **Workflow process** (dedicated spec, real QuanticFlow over HTTP) | Real QuanticFlow + Keycloak service token | **Real** — BPMN routing, gateways, retry loops, and signal-backs are the thing under test. |

**Mock at a DI token for one of these reasons:**

1. **App-integration isolation** — mock the workflow client, Kafka publisher, AI provider, and any WebSocket gateway in harness suites (the real engine/broker are exercised in their own layer).
2. **Fault injection** — exercise a failure path you can't reliably trigger on the real service (e.g. "QuanticFlow down" for the rollback test in §5).
3. **Genuinely-external boundaries** — Anthropic (`AI_PROVIDER`) and third-party APIs (GitHub) are always stubbed (cost, rate limits, non-determinism).

Pass mocks to the harness via `mockExternals` — an **array of `{ token, useValue }`** (the token is a string or the provider class):

```typescript
harness = await createIntegrationHarness({
  modules: [DocumentModule, OrderModule],
  mockExternals: [
    { token: WorkflowClientService, useValue: mockWorkflowClient }, // app-integration isolation
    { token: KafkaEventPublisher, useValue: mockKafkaPublisher },   // app-integration isolation
    { token: AI_PROVIDER, useValue: mockAiProvider },               // external — always mocked
    { token: 'GITHUB_SERVICE', useValue: mockGithubService },       // external — always mocked
  ],
});
```

Tests run with `DB_SYNCHRONIZE=false` — migrations are tested explicitly; auto-sync is local-dev only.

## Mock-Drift Contract Canary

Hand-written stubs and golden fixtures for genuinely-external dependencies (Anthropic via the AI Gateway, GitHub, payment providers) **silently rot** — the upstream changes and the fixture keeps passing. Every external boundary that is stubbed in normal tests MUST have a **contract canary** that closes the gap.

A canary:

- Runs against the **real** external dependency (not the hermetic stack's local/mock substitute).
- Asserts response **shape** (schema), **never** generated content — externals are non-deterministic.
- Runs **out of band** — on a schedule or on demand, **never** in `npm test` / PR CI (it is slow, costs money, and is non-deterministic).
- **Self-skips** when its target env (e.g. `AI_GATEWAY_URL`) is absent, so the suite is safe to run anywhere.

**Conventions:**

- Name canary files `*.canary.ts` (**not** `*.spec.ts`) so the unit/integration Jest regexes never pick them up.
- Run via a dedicated config: `jest.canary.config.ts` (`testRegex: '.*\\.canary\\.ts$'`) + a `test:canary` script.
- Reuse the **same schema** that defines the app's expectation of the dependency (e.g. the Zod mirror of the provider response, or the `jsonSchema` sent for structured output).

**Drift signal:** the canary fails while the mocked/golden tests pass ⇒ the fixtures encode a stale shape → refresh them.

Each consumer app keeps the concrete canary (target URLs, env, run command) in its project-local `testing-external-deps.md` and `docs/`.

## Authentication in Integration Tests

### Backend: Keycloak Direct Access Grant

Obtain real tokens from the test Keycloak using the direct access grant (Resource Owner Password Credentials).
Keycloak is exposed to the host on this app's band port (`8N99` — e.g. N=1: `8199`; see the
Per-App Port Band scheme below) by `docker-compose.test.yml`. The test realm is imported via
`--import-realm` from a realm JSON under `keycloak/` (e.g. `keycloak/realm-test.json`).

> **One realm, one source of truth (see `sso-architecture.md`).** A multi-app platform shares a
> **single** Keycloak realm — the test realm is that same realm, not a per-app invention. Keep its
> canonical JSON in one repo (the platform/shell app) and **copy it verbatim** into each consuming
> app's `keycloak/` for its standalone test stack; the copies must stay byte-identical (a drifted
> copy silently grants the wrong clients/redirect-URIs). When you add an app's band callbacks, edit
> the **canonical** realm and re-propagate — don't hand-edit a copy.

```typescript
const KEYCLOAK_URL = `http://localhost:${process.env.TEST_KEYCLOAK_PORT ?? 8199}`;
async function getKeycloakToken(username: string, password: string): Promise<string> {
  const res = await fetch(`${KEYCLOAK_URL}/realms/your-realm/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'your-app-backend',
      client_secret: 'change-me',
      username,
      password,
    }),
  });
  const data = await res.json();
  return data.access_token;
}
```

### Frontend: Saved Storage State (setup-project pattern)

Best practice is a dedicated **`setup` project** that authenticates once via real Keycloak and writes `storageState` into the project's **`outputDir`** (auto-cleaned each run) — NOT a committed path under `e2e/auth/`. Test projects declare `dependencies: ['setup']` + `use: { storageState }` so they start authenticated, and the state file can never be accidentally committed (it lives in the gitignored output dir, not the source tree).

```typescript
// playwright.integration.config.ts
const authFile = 'playwright/.auth/user.json'; // under outputDir / gitignored — never the source tree
export default defineConfig({
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'integration',
      dependencies: ['setup'],
      use: { storageState: authFile },
    },
  ],
});
```

Project dependencies (over a bare `global-setup.ts`) integrate with tracing, reporting, and retries, and parallel-safe auth can override `storageState` per worker keyed on `testInfo.parallelIndex`. **Never check the storage-state file into the repo** — it carries httpOnly session cookies.

### Test Users — ILLUSTRATIVE EXAMPLE (define your own per app)

The table below is an **example only**. **Each app defines its own test users** in its own Keycloak test realm, and the permission names shown are **example permissions in `resource:action` format** — **replace them with your app's real roles and permissions**. Use this as a shape to copy, not a fixed roster.

> ⚠️ Since v7, the `admin` realm role does NOT bypass `@Permission(...)` checks. The `admin` fixture works because it is granted all client-role permissions explicitly in the test realm — any test relying on role-only admin access will get 403.

| User | Password | Roles | Permissions (example — replace per app) | Use for |
|---|---|---|---|---|
| `admin` | `admin` | `user`, `admin` | All permissions (granted explicitly) | Admin-only endpoints, full access flows |
| `creator` | `creator` | `user` | `<resource>:create`, `<resource>:read` | Resource creation, limited access |
| `manager` | `manager` | `user` | `<resource>:manage`, `<resource>:read` | Resource CRUD, assignment |
| `reviewer` | `reviewer` | `user` | `<resource>:review`, `<resource>:read` | Review / approval flows |
| `viewer` | `viewer` | `user` | `<resource>:read` | Read-only flows |

## Backend Integration Test Categories

Every module's integration test covers these categories (as applicable):

### 1. API Contract Tests

Verify HTTP verb + path + payload → expected status + response shape.

```typescript
it('GET /api/orders returns paginated list', async () => {
  await seedOrders(harness, 3);
  const res = await harness.request()
    .get('/api/orders')
    .set('Cookie', harness.authCookies.admin);

  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(3);
  expect(res.body.total).toBe(3);
  expect(res.body.data[0]).toHaveProperty('id');
  expect(res.body.data[0]).toHaveProperty('name');
  expect(res.body.data[0]).toHaveProperty('status');
});
```

### 2. DB Constraint Tests

Verify the database enforces business rules.

```typescript
it('rejects order with duplicate slug', async () => { /* 409 */ });
it('cascades delete to child documents', async () => { /* verify orphans removed */ });
it('enforces NOT NULL on required fields', async () => { /* 400/422 */ });
```

### 3. Permission Tests

Verify role/permission-gated endpoints.

```typescript
it('admin can list all orders', async () => { /* 200 */ });
it('non-admin sees only own orders', async () => { /* 200, filtered */ });
it('viewer cannot create orders', async () => { /* 403 */ });
```

### 4. Cross-Module Flow Tests

Verify operations that span module boundaries via CommandBus.

```typescript
it('confirming cart creates order', async () => {
  const cart = await seedCart(harness);
  const res = await harness.request()
    .post(`/api/carts/${cart.id}/confirm`)
    .set('Cookie', harness.authCookies.admin);

  expect(res.status).toBe(200);

  const order = await harness.dataSource.query(
    `SELECT * FROM sales.orders WHERE "cartId" = $1`,
    [cart.id],
  );
  expect(order).toHaveLength(1);
});
```

### 5. Transaction Rollback Tests

Verify that partial failures roll back all changes.

```typescript
it('rolls back order on workflow start failure', async () => {
  mockQuanticFlowClient.startProcess.mockRejectedValue(new Error('QuanticFlow down'));

  const res = await harness.request()
    .post('/api/orders')
    .set('Cookie', harness.authCookies.admin)
    .send({ name: 'Should Rollback', category: 'standard', priority: 'High' });

  expect(res.status).toBe(500);

  const rows = await harness.dataSource.query(
    `SELECT * FROM sales.orders WHERE name = $1`, ['Should Rollback'],
  );
  expect(rows).toHaveLength(0);
});
```

### 6. Degradation & Health Tests

Verify observability and graceful-degradation behavior (see `observability-backend.md` / `resilience-ops.md`):

```typescript
it('exposes quanticjs_* metrics after a dispatch', async () => {
  // dispatch one command, then GET /metrics → body contains quanticjs_commands_total
});
it('readiness returns 503 with kafka_consumers detail when a consumer run-loop rejects', async () => {
  // mock the consumer run() rejection; assert after the health-cache TTL (default 5000ms)
});
it('boots and dispatches without the metrics module (behaviors no-op)', async () => { /* ... */ });
it('feature-flag provider outage: fallback "skip" executes, default "throw" returns Forbidden, process does not crash', async () => { /* ... */ });
```

**Prometheus registry isolation:** integration tests boot real modules repeatedly — the prom-client global registry survives across boots. Pass a fresh `Registry` via the `METRICS_REGISTRY` token or call `register.clear()` in `afterEach`.

### 7. Outbox & Event Consumption Tests

The transactional outbox is the system's most load-bearing guarantee: "messages are guaranteed to be sent if and only if the database transaction commits" (microservices.io/patterns/data/transactional-outbox). Every module that publishes events needs:

```typescript
it('writes outbox event in the same transaction as the entity', async () => {
  const res = await harness.request()
    .post('/api/orders')
    .set('Cookie', harness.authCookies.admin)
    .send({ name: 'Evented' });

  const outbox = await harness.dataSource.query(
    `SELECT * FROM "events"."outbox_events" WHERE "aggregateId" = $1`, [res.body.id],
  );
  expect(outbox).toHaveLength(1);
  expect(outbox[0].type).toBe('order.created');
});

it('writes NO outbox event when the transaction rolls back', async () => {
  mockQuanticFlowClient.startProcess.mockRejectedValue(new Error('down'));
  await harness.request().post('/api/orders')
    .set('Cookie', harness.authCookies.admin).send({ name: 'Rolled Back' });

  const outbox = await harness.dataSource.query(
    `SELECT * FROM "events"."outbox_events" WHERE payload->>'name' = $1`, ['Rolled Back'],
  );
  expect(outbox).toHaveLength(0); // atomicity is the whole point of the outbox
});

it('consumer is idempotent: redelivering the same event has a single effect', async () => {
  // Invoke the consumer's handleMessage twice with an identical KafkaEvent
  // (same eventId/aggregateId) — assert the side effect (DB row, notification)
  // exists exactly once. Idempotent-consumer pattern: dedup by message ID
  // (microservices.io/patterns/communication-style/idempotent-consumer).
});

it('consumer throws on failed Result so retry/DLQ engages (never silently acks)', async () => {
  // Per ADR-008: a failed command Result inside handleMessage must throw —
  // assert handleMessage rejects when the dispatched command fails.
});
```

### 8. Cross-Tenant Isolation Tests (multi-tenant mode only)

Applications in multi-tenant mode (ADR-024: JWT org claim → `TenantSubscriber` → RLS) must prove the boundary holds — a missing test here is a silent data leak. Skip this category entirely in single-tenant apps.

```typescript
it('tenant B cannot read tenant A resources', async () => {
  const orderA = await seedOrder(harness, { cookie: harness.authCookies.tenantAUser });
  const res = await harness.request()
    .get(`/api/orders/${orderA.id}`)
    .set('Cookie', harness.authCookies.tenantBUser);
  expect([403, 404]).toContain(res.status); // never 200
});

it('list endpoints return only the caller tenant rows', async () => { /* seed both tenants, assert filtering */ });

it('RLS denies tenant-scoped writes when token has no org claim (fail-closed)', async () => {
  // Token without organizationId → tenant context null → set_config never runs
  // → RLS rejects the write. This is correct behavior per ADR-024 — assert it.
});

it('entity-supplied organizationId never overrides context (mismatch throws)', async () => {
  // POST a payload carrying a different organizationId than the caller's —
  // TenantSubscriber stamps from context and a mismatch must throw, not silently win.
});
```

## Framework-Level Integration Tests (quanticjs-backend)

The framework repo carries its own integration suites, distinct from the consumer-app categories above:

- **core**: pipeline-composition, auth-context, and integrity-service suites (in-proc module boot)
- **redis, feature-flags**: module-registration dedup guards (duplicate `forRoot()` / duplicate behavior detection)
- **events-redis**: Redis Streams suite via Testcontainers — XAUTOCLAIM reclaim, dead-letter after exactly `maxDeliveries`, PEL drain
- **workflow-quanticflow**: QuanticFlow in-process HTTP stub (idempotency-key dedup, token timeout, single-flight) + HMAC callback E2E

Integration configs deliberately clear coverage thresholds — integration is not a coverage gate.

## Frontend Integration Journey Structure

Journeys are **serial, multi-step flows** — not isolated page tests. Each journey tests a complete user workflow across multiple pages and API calls.

```typescript
test.describe.configure({ mode: 'serial' });

test.describe('Journey: Order Lifecycle', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Integration tests run on chromium only');

  test('step 1: create order via cart', async ({ page }) => { /* ... */ });
  test('step 2: order appears on dashboard', async ({ page }) => { /* ... */ });
  test('step 3: order detail shows correct data', async ({ page }) => { /* ... */ });
  test('step 4: line items tab shows the order contents', async ({ page }) => { /* ... */ });
});
```

## Asynchronous & Eventual-Consistency Waits

Platform flows are event-driven. A single user action propagates through several services before the result is observable:

```
UI click → Kafka command (quantic.commands) → QuanticFlow engine
        → Kafka event (quantic.events.*) → app consumer → DB write → UI reflects
```

Integration and full-stack journey tests therefore wait for **eventual consistency** — the result is not present on the next tick. **Never** sleep for a fixed duration (`waitForTimeout`); always wait on a *condition*. Use these patterns, in order of preference:

### 1. Web-first assertion with an extended timeout (default for UI-observable state)
Assert on the element that reflects the eventual state — Playwright auto-retries until it appears or the timeout elapses.
```typescript
await expect(page.getByText('In Review')).toBeVisible({ timeout: 15_000 });
```

### 2. Poll the API, not the clock (when there is no immediate UI signal)
```typescript
await expect
  .poll(
    () => apiContext.get(`/api/orders/${orderId}`).then(r => r.json()).then(p => p.status),
    { timeout: 20_000, intervals: [500, 1000, 2000] },
  )
  .toBe('in-review');
```

### 3. Assert the message / side-effect (backend integration)
Drive the action, then verify the **observable outcome** of the consumer — a DB row written by the consumer, or the emitted Kafka event — rather than the engine's internals.
```typescript
await expect
  .poll(async () => {
    const rows = await harness.dataSource.query(
      `SELECT status FROM sales.orders WHERE id = $1`, [orderId],
    );
    return rows[0]?.status;
  }, { timeout: 20_000 })
  .toBe('in-review');
```

### 4. `waitForResponse` to synchronize on the round-trip
```typescript
await Promise.all([
  page.waitForResponse(r => r.url().includes('/api/orders') && r.request().method() === 'POST'),
  page.getByRole('button', { name: 'Submit' }).click(),
]);
```

**Choosing a timeout:** size it to the propagation path, not a guess. A same-service write resolves in ~1–2s; a full Kafka → QuanticFlow → consumer → DB round trip can take 5–15s on the test stack. Prefer `expect.poll`/web-first (which return as soon as the condition holds) over a long fixed `expect` timeout (which always waits the full duration on failure).

> **Anti-pattern:** `await page.waitForTimeout(3000)` to "let the workflow finish." Slow *and* flaky — the workflow may take 2s or 12s depending on stack load. Wait on the resulting UI state, API state, or DB/event side-effect instead.

## Test Infrastructure

### Framework repo (quanticjs-backend)

| Infrastructure | Purpose |
|---|---|
| 5× `jest.config.integration.js` | Per-package Jest configs for `*.integration-spec.ts` files (coverage thresholds deliberately cleared) |
| Turbo `test:integration` task | Runs integration suites as their own CI stage and publish gate |
| Testcontainers (events-redis only) | Real Redis for the Redis Streams suite |
| In-process HTTP stubs + supertest (workflow-quanticflow) | QuanticFlow contract without a live engine |
| In-proc module-boot suites (core, redis, feature-flags) | Pipeline composition and module-registration guards |

### Consumer app (your-app)

| File | Purpose |
|---|---|
| `docker-compose.test.yml` | PostgreSQL, Redis, Keycloak, backend on isolated ports |
| `client/playwright.integration.config.ts` | Playwright config for integration tests |
| `client/e2e/integration/global-setup.ts` | Keycloak auth before all tests |
| `client/e2e/integration/global-teardown.ts` | DB cleanup after all tests |
| `client/e2e/integration/fixtures.ts` | Real auth, API context, seed/cleanup helpers |
| `src/test/integration-harness.ts` | NestJS test harness with real DB/Redis |
| `jest.config.integration.js` | Jest config for `*.integration-spec.ts` files |

### Test Ports — Per-App Port Band scheme (isolated from dev)

Every app's test stack must bind **distinct host ports** so multiple apps' test stacks can run
concurrently on one dev machine (a single shared port like `8099` for all apps means only one app's
test stack runs at a time — the most common local-dev collision). Ports follow a per-app band keyed
on an app index **N (1–9)**:

| Service | Pattern | URL |
|---|---|---|
| Keycloak | `8N99` | `http://localhost:8N99` |
| Backend API | `3N99` | `http://localhost:3N99` |
| Frontend (Vite) | `5N99` | `http://localhost:5N99` |

**Each app claims one `N` and records it in its OWN `docker-compose.test.yml`** — there is no central
registry to update. Pick an `N` whose band is not bound by any other test stack you run locally; the
example bands below are illustrative, not an allocation:

| Example | N | Keycloak | API | Vite |
|---|---|---|---|---|
| _your app_ | 1 | 8199 | 3199 | 5199 |
| _another app_ | 2 | 8299 | 3299 | 5299 |
| _a third app_ | 3 | 8399 | 3399 | 5399 |

**Env-var contract.** Each app's `docker-compose.test.yml` binds host ports through three variables,
baking **its own band as the defaults** so the file is self-contained (substitute the app's chosen
`N` — `8N99`/`3N99`):

```yaml
# your-app (chosen N=1) docker-compose.test.yml
keycloak: { ports: ['${TEST_KEYCLOAK_PORT:-8199}:8080'] }
backend:  { ports: ['${TEST_API_PORT:-3199}:3000'] }
```

The frontend dev server and `save-auth-state.ts` read the same band:

```bash
cd client && VITE_API_URL=http://localhost:${TEST_API_PORT:-3199} \
  npm run dev -- --port ${TEST_WEB_PORT:-5199}
cd client && APP_URL=http://localhost:${TEST_WEB_PORT:-5199} npx tsx ../scripts/save-auth-state.ts
```

The orchestrator skills (`/e2e-full`, `/int-full`) resolve these from the app's compose at Phase 0
and export them for the session — individual commands never hardcode a literal port.

- **OIDC redirect URIs follow the band.** The browser auth flow needs the BFF callback in Keycloak's
  client redirect-URI allowlist. The **test realm** (`keycloak/realm-test.json`) must list this app's
  Vite/API callbacks (`http://localhost:5N99/*`, `http://localhost:3N99/*`) — otherwise shifting the
  port to avoid a collision dead-ends at a redirect-mismatch. (Test realm only; production redirect
  URIs stay strict — see `sso-architecture.md`.)
- **CI is unaffected** — runners are isolated, so any band works there; the per-app bands exist only
  to deconflict the shared local dev machine.

## Hard Constraints

- **NEVER use `page.route()` in integration tests** — all API calls must hit the real backend; mocking defeats the purpose
- **NEVER import from `client/e2e/fixtures.ts`** in integration tests — use `client/e2e/integration/fixtures.ts` instead (different auth strategy, no mock helpers)
- **NEVER import from `client/e2e/mocks/`** in integration tests — data comes from the real API or direct DB seeding, not static mock builders
- **NEVER run integration tests against the dev stack** — always use `docker-compose.test.yml` on this app's port band (see the Per-App Port Band scheme; never the dev ports 3000/8080/5173)
- **NEVER bind two apps' test stacks to the same host ports** — each app owns a distinct `N` band (recorded in its own `docker-compose.test.yml`) so their test stacks coexist on a shared dev machine; pick a free `N` rather than reusing another app's band
- **NEVER stub owned platform services (QuanticFlow, File Service, Notification Engine) just because they cross a process boundary** — run them real in the hermetic stack; mock them only to inject a fault you can't otherwise trigger
- **NEVER assert on an owned service's internals** (QuanticFlow's engine state, the File Service's storage layout) — assert on *observable outcomes* (status transitions, DB rows, emitted Kafka events)
- **NEVER call genuinely-external services for real in integration tests** (Anthropic, GitHub) — mock them; verify their real contract only in the scheduled canary suite
- **NEVER hard-code UUIDs** in integration tests — create data first, capture the ID from the response
- **NEVER skip database cleanup** — stale data from previous runs causes false passes and flaky tests
- **NEVER run frontend integration tests in parallel** — serial only (`test.describe.configure({ mode: 'serial' })`)
- **NEVER run frontend integration tests on non-chromium browsers** — `test.skip(({ browserName }) => browserName !== 'chromium')`
- **NEVER use `page.waitForTimeout()`** — use web-first assertions or `waitForResponse`/`waitForURL`
- **NEVER use CSS selectors** — use semantic locators (`getByRole`, `getByLabel`, `getByText`)

## Style Guide

- **Name test suites after the journey**, not the page: "Cart to Order Delivery" not "Cart Page"
- **Serial within a journey** — use `test.describe.configure({ mode: 'serial' })` when tests depend on prior state
- **Prefix backend describes** with the module: `OrderModule (integration)`, `Auth Flow — Real Keycloak`
- **Assert both status AND body** in backend tests — status alone doesn't verify the response shape
- **Assert both UI AND URL** in frontend tests — UI content + `toHaveURL` catches silent redirect bugs
- **Use `test.slow()`** for journeys with multiple API round trips
- **Log seed data IDs** via `test.info().annotations` for debugging failed runs
- **One journey per describe block** — don't mix independent journeys in the same serial chain
- **Backend tests: `afterEach` cleanup** — truncate between each test for isolation
- **Frontend tests: `beforeAll` seeding** — seed once for the journey, cleanup in `afterAll`
