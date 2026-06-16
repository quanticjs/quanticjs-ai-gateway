---
globs: "client/e2e/**/*.ts, client/playwright.config.ts"
---

# Testing — E2E UI (Playwright, Mocked APIs)

All API calls are mocked with `page.route()`. Tests verify the UI renders correctly and user interactions work.

## Shared Fixtures (MANDATORY)

All specs import from `client/e2e/fixtures.ts` — **NEVER** from `@playwright/test` directly.

```typescript
import { test, expect, mockAuth, mockNotifications, mockUnauthenticated, checkA11y, SESSIONS } from './fixtures';
```

| Export | Purpose |
|---|---|
| `test`, `expect` | Re-exported from Playwright — `test` extends base with global error monitoring |
| `mockAuth(page, session?)` | Mocks `/auth/me` + `/auth/refresh` with a `SESSIONS` preset |
| `mockNotifications(page)` | Mocks `**/api/notifications/**` with empty data |
| `mockUnauthenticated(page)` | Mocks `/auth/me` returning 401 |
| `checkA11y(page)` | Runs axe-core WCAG 2.2 AA scan — call in happy path tests |
| `SESSIONS` | Named presets for each role/permission combination — see below and `fixtures.ts` for the full list |

### Session Presets

Each preset provides `roles` (realm roles) and `permissions` (client roles in `resource:action` format). Choose the preset matching the page's access requirements:

| Preset | Roles | Permissions | Use for |
|---|---|---|---|
| `SESSIONS.viewer` | `['user']` | `[]` | Pages with no permission requirement |
| `SESSIONS.crCreator` | `['user']` | `['cr.read', 'cr.create']` | CR creation pages |
| `SESSIONS.admin` | `['user', 'admin']` | All DH permissions | Admin-only pages (IAM audit, system config) |

For a complete list, see `client/e2e/fixtures.ts`. When a new page requires a preset not in `SESSIONS`, add it to fixtures:

```typescript
export const SESSIONS = {
  // ...existing...
  newPreset: { ...DEFAULT_SESSION, roles: ['user'], permissions: ['feature:read', 'feature:write'] },
} as const satisfies Record<string, SessionOptions>;
```

**Admin pages** (e.g., `/admin/iam/*`) must use `SESSIONS.admin` — these pages check for the `admin` realm role, not individual permissions.

> ⚠️ Since v7, the backend's `admin` realm role does NOT bypass `@Permission(...)` checks — `SESSIONS.admin` works because the preset carries all permissions explicitly. Don't model a session with `roles: ['admin']` and empty permissions and expect permission-gated calls to succeed.

### Global Error Monitoring (built into fixtures.ts)

The `test` export extends Playwright's base test to **fail on unexpected page errors**. React rendering errors, unhandled promise rejections, and console errors are caught automatically — no per-spec setup needed.

```typescript
// fixtures.ts — test is extended with page error collection + a11y helper
import AxeBuilder from '@axe-core/playwright';

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await use(page);
    expect(errors, 'Unexpected page errors during test').toEqual([]);
  },
});

export async function checkA11y(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}
```

If a test intentionally triggers a page error (e.g., testing error boundary rendering), suppress it:

```typescript
test('error boundary catches render crash', async ({ page }) => {
  page.removeAllListeners('pageerror');
  // ... test that triggers intentional error ...
});
```

## Page Type Classification

Classify each page before writing tests. Required coverage depends on the page type.

| Page Type | Characteristics | Required Tests |
|---|---|---|
| **Data list** | Fetches collection via `useApiQuery`, renders list/table/cards | All 5 states + mutations (if actions) + mobile + a11y |
| **Detail** | Fetches single resource, may have sub-resource queries | All 5 states + partial error for independent sub-queries + mobile + a11y |
| **Form / wizard** | Multi-step form, file upload, or creation flow | Submit success + submit error + validation + loading + mobile + a11y |
| **Static / stub** | No API calls, renders static content | Happy path + mobile (if responsive layout) + a11y |
| **Hybrid / multi-phase** | Single route that transitions between page types (e.g., form → detail/chat → confirmation form) | Per-phase coverage — each phase tested as its own page type (see below) |
| **Auth** | Login, callback, logout flows | Authenticated redirect + unauthenticated flow + a11y |

Use the matching template. Do not force the 5-state template onto pages that lack API-driven states.

**Where these states belong (test distribution — Testing Trophy).** Pure presentational permutations of a component (a badge's variants, a skeleton in isolation, a form field's error styling) belong in **component tests** (Vitest + RTL) — faster, closer to the unit, and the right tier for dense state matrices. Reserve E2E 5-state coverage for states where the **page-level wiring** is the risk: `useApiQuery`/router integration, `refetch` recovery, empty/error rendering driven by real hooks, and auth-gated redirects. E2E is the thinner, integration-focused tier ("write tests, not too many, mostly integration") — don't re-cover a component's internal state matrix at the E2E layer.

### Hybrid / multi-phase pages

Some pages transition through distinct phases on a single route — e.g., an initial form that creates a resource, then a detail/chat view for interaction, then a confirmation form to finalize. Each phase has its own mutations and UI states.

**How to classify:** A page is hybrid when it has 2+ `useApiMutation` hooks that drive distinct user-visible phases (not just independent actions on the same view like "delete" and "archive").

**Required coverage:** Identify each phase, classify it by sub-type (form or detail), and apply that sub-type's required tests. The happy-path test walks through all phases as a connected journey. Error/loading tests are per-phase.

| Phase sub-type | Required tests |
|----------------|----------------|
| Form phase | Submit success (part of journey) + submit error + loading |
| Detail phase | Fetch error + fetch recovery (if it fetches data) + mutation error per action |

A page may have any number of phases in any combination — the table above applies per phase, not to a fixed structure.

Mutation-specific edge cases (malformed API responses, unexpected null values) belong in integration or component tests, not E2E — see [Per-Phase Mutation Coverage](#per-phase-mutation-coverage-hybrid-pages) below.

## Coverage Requirements

### Data list and detail pages — all 5 states

| State | What to test | How to assert |
|-------|-------------|---------------|
| **Happy path** | Feature works as expected | Assert specific data content + `toHaveURL` + `checkA11y(page)` |
| **Error state** | API failure shows error UI | `getByText(/failed to load/i)` — NOT heading |
| **Error recovery** | Retry button refetches and renders data | Click retry → assert data visible |
| **Empty state** | No data shows empty UI | `getByText(/no <items>/i)` |
| **Loading state** | Skeleton/spinner shown while loading | `getByRole('status')` — NOT heading |

**Why recovery matters:** A retry button that doesn't call `refetch` is a silent UX failure. No other test level detects broken retry wiring — only E2E recovery tests catch it.

Pages with **forms or action buttons** (approve, reject, submit, delete) also test mutations — see [Mutation / Action Testing](#mutation--action-testing) below.

### Form / wizard pages

| State | What to test |
|-------|-------------|
| **Submit success** | Fill form → submit → verify success toast or redirect |
| **Submit error** | Submit → API 500 → verify error visible to user |
| **Validation** | Submit with invalid/missing data → verify field-level errors |
| **Loading** | Verify loading indicator during submission |

### Static / stub pages

| State | What to test |
|-------|-------------|
| **Happy path** | Page renders heading + key content + `toHaveURL` + `checkA11y(page)` |

### Data list / detail page template

```typescript
import { test, expect, mockAuth, mockNotifications, checkA11y, SESSIONS } from './fixtures';
import { build<Item>, build<Item>ListResponse } from './mocks/<resource>';

test.describe('<PageName> Page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuth(page, SESSIONS.<appropriatePreset>);
    await mockNotifications(page);
  });

  test('shows data on success', async ({ page }) => {
    await page.route('**/api/<resource>*', route => route.fulfill({
      status: 200, json: build<Item>ListResponse(),
    }));
    await page.goto('/<route>');
    await expect(page).toHaveURL('/<route>');
    await expect(page.getByText('<expected data>')).toBeVisible();
    await checkA11y(page);
  });

  test('shows error message on API failure', async ({ page }) => {
    await page.route('**/api/<resource>*', route => route.fulfill({ status: 500 }));
    await page.goto('/<route>');
    await expect(page.getByText(/failed to load/i)).toBeVisible();
  });

  test('recovers from error on retry', async ({ page }) => {
    let callCount = 0;
    await page.route('**/api/<resource>*', route => {
      callCount++;
      if (callCount === 1) return route.fulfill({ status: 500 });
      return route.fulfill({ status: 200, json: build<Item>ListResponse() });
    });
    await page.goto('/<route>');
    await expect(page.getByText(/failed to load/i)).toBeVisible();
    await page.getByRole('button', { name: /try again|retry/i }).click();
    await expect(page.getByText('<expected data>')).toBeVisible();
  });

  test('shows empty state when no data', async ({ page }) => {
    await page.route('**/api/<resource>*', route => route.fulfill({
      status: 200, json: build<Item>ListResponse([]),
    }));
    await page.goto('/<route>');
    await expect(page.getByText(/no <items>/i)).toBeVisible();
  });

  test('shows loading while fetching', async ({ page }) => {
    await page.route('**/api/<resource>*', async route => {
      await new Promise(r => setTimeout(r, 2000));
      await route.fulfill({ status: 200, json: build<Item>ListResponse([]) });
    });
    await page.goto('/<route>');
    await expect(page.getByRole('status')).toBeVisible();
  });
});
```

## Auth Mocking (MANDATORY)

Auth uses BFF httpOnly cookies — **not** localStorage/sessionStorage tokens.

Use `mockAuth()` from fixtures in `beforeEach`:

```typescript
test.beforeEach(async ({ page }) => {
  await mockAuth(page, SESSIONS.<appropriatePreset>);
  await mockNotifications(page);
});

test('unauthenticated user redirected to login', async ({ page }) => {
  await mockUnauthenticated(page);
  await page.goto('/<protected-route>');
  await expect(page).toHaveURL(/\/login/);
});
```

## Locators — Semantic ONLY

```typescript
// WRONG — CSS class selectors
page.locator('.btn-primary');
page.locator('.fixed.inset-0');
page.locator('[class*="animate-pulse"]');

// WRONG — attribute selectors (use getByRole/getByLabel instead)
page.locator('[role="status"]');
page.locator('[aria-label="Loading"]');
page.locator('[data-testid="submit"]');

// CORRECT — semantic locators
page.getByRole('button', { name: 'Submit' });
page.getByRole('heading', { name: 'Projects' });
page.getByRole('status');
page.getByLabel('Email address');
page.getByLabel('Loading');
page.getByText('Welcome back');
page.getByPlaceholder('Search...');
```

**Priority** (Playwright user-facing locators): `getByRole` > `getByLabel` (form controls) > `getByText` (non-interactive content) > `getByPlaceholder` > `getByTestId` (last resort). Role-first matches how users and assistive tech perceive the page — the same accessibility tree an agent reads from `browser_snapshot`. Playwright's published order lists `getByText` before `getByLabel`; in practice reserve `getByLabel` for form fields and `getByText` for content, and use `getByTestId` only when there is no accessible name. CSS/XPath are not on the list — they couple tests to DOM structure.

Chain and filter to narrow scope:
```typescript
const card = page.getByRole('listitem').filter({ hasText: 'My Project' });
await card.getByRole('link', { name: 'View' }).click();
```

## Route Setup Order (CRITICAL)

`page.route()` **must** be registered BEFORE `page.goto()`. If the route handler is set up after navigation, the initial request fires before the mock is active and hits the real (non-existent) backend.

```typescript
// WRONG — goto fires before route is registered, mock never intercepts
await page.goto('/<route>');
await page.route('**/api/<resource>*', route => route.fulfill({ status: 200, json: data }));

// CORRECT — route registered first, then navigation triggers the mock
await page.route('**/api/<resource>*', route => route.fulfill({ status: 200, json: data }));
await page.goto('/<route>');
```

This also applies to mutations: register `page.route()` for the action endpoint **before** clicking the button that triggers the request.

### Always end a handler with `route.fallback()`

A `page.route()` handler that doesn't handle a request method (or path) leaves the request **hanging until timeout with no useful error** — the test fails slowly and opaquely. Every handler must have a fallback for unmatched requests:

```typescript
// WRONG — non-GET (or any unhandled) request hangs until timeout
await page.route('**/api/items*', route =>
  route.fulfill({ status: 200, json: buildItemListResponse() }),
);

// CORRECT — handled cases fulfilled; everything else falls through
await page.route('**/api/items*', route => {
  if (route.request().method() === 'GET') {
    return route.fulfill({ status: 200, json: buildItemListResponse() });
  }
  return route.fallback(); // hand off to the next handler / default behaviour
});
```

Use `route.fallback()` (try the next matching handler) over `route.continue()` unless you specifically intend to hit the real network.

## Assertions — Web-First Only

```typescript
// WRONG — checks once, no retry, FLAKY
expect(await page.getByText('welcome').isVisible()).toBe(true);

// CORRECT — retries until visible or timeout
await expect(page.getByText('welcome')).toBeVisible();
await expect(page.getByRole('heading')).toHaveText('Dashboard');
await expect(page).toHaveURL('/projects');
```

## Waiting — Correct Alternatives

```typescript
// WRONG
await page.waitForTimeout(500);

// CORRECT
await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
await page.waitForURL('/projects');
await page.waitForResponse('**/api/projects');
await expect(page.getByRole('heading')).toHaveText('Success');
```

### Simulated async in mocked tests

In mocked E2E, responses are instant — there is **no real eventual consistency** to wait for. When a page *polls* an endpoint until a status changes (e.g. a workflow advancing), simulate the transition with sequential mock responses and assert the UI reflects the final state with a web-first assertion:

```typescript
let polls = 0;
await page.route('**/api/projects/project-1', route => {
  polls++;
  return route.fulfill({
    status: 200,
    json: buildProject({ status: polls < 2 ? 'Intake' : 'In Review' }),
  });
});
await page.goto('/projects/project-1');
await expect(page.getByText('In Review')).toBeVisible(); // auto-retries across the page's refetches
```

> Waiting for **real** asynchronous propagation (Kafka → QuanticFlow → consumer → DB → UI) is an **integration / full-stack** concern, not a mocked-E2E one — see the "Asynchronous & Eventual-Consistency Waits" section in `testing-integration.md`.

## Responsive Viewport Testing

Pages with responsive layout changes (sidebar collapse, grid→stack, tabs→accordion) include a mobile test block — a separate `describe` with mocks re-registered and:

```typescript
test.use({ viewport: { width: 375, height: 812 } });
```

**When to include mobile blocks:**
- Data list/detail pages with responsive grids or sidebars — always
- Form pages with multi-column layouts — always
- Static/stub pages with a single content card and no layout changes — skip
- Optional tablet block (`768 x 1024`) when the page has a distinct tablet breakpoint (e.g., collapsed sidebar, different grid)

## Mutation / Action Testing

### Per-Phase Mutation Coverage (hybrid pages)

On hybrid / multi-phase pages, each phase's primary mutation must have the tests required by that phase's page type. A page with 3 phases (create form → chat detail → confirmation form) needs submit-error tests for **both** form phases — not just one. The e2e-scan checks this by counting phases and their mutation coverage independently.

Mutation-specific edge cases (malformed responses, unexpected null values, partial payloads) belong in **integration or component tests**, not E2E — see `testing-integration.md`.

### Action testing pattern

```typescript
test('submits action and shows success', async ({ page }) => {
  await page.route('**/api/<resource>/<id>/<action>', route => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 200, json: { status: 'Done' } });
    }
    return route.fulfill({ status: 200, json: [] });
  });

  const requestPromise = page.waitForRequest(req =>
    req.url().includes('/api/<resource>/<id>/<action>') && req.method() === 'POST',
  );

  await page.getByRole('button', { name: '<Action>' }).click();

  const request = await requestPromise;
  expect(request.postData()).toBeTruthy();
  await expect(page.getByText(/<success message>/i)).toBeVisible();
});

test('shows error when action fails', async ({ page }) => {
  await page.route('**/api/<resource>/<id>/<action>', route => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 500 });
    }
    return route.fulfill({ status: 200, json: [] });
  });

  await page.getByRole('button', { name: '<Action>' }).click();
  await expect(page.getByText(/something went wrong/i)).toBeVisible();
});
```

For form submissions, verify the full flow including redirects:

```typescript
test('submits form and redirects to list', async ({ page }) => {
  await page.route('**/api/items', route => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 201, json: { id: 'new-1' } });
    }
  });

  await page.getByLabel('Name').fill('New Item');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expect(page).toHaveURL('/items');
});
```

## Partial Error States (pages with multiple independent queries)

When a page fetches data from multiple endpoints, test that one section's failure doesn't break other sections:

```typescript
test('shows error for section B but section A data still visible', async ({ page }) => {
  await page.route('**/api/<resource>/<id>', route =>
    route.fulfill({ status: 200, json: build<Item>() }),
  );
  await page.route('**/api/<resource>/<id>/<sub-resource>', route =>
    route.fulfill({ status: 500 }),
  );

  await page.goto('/<resource>/<id>');
  await expect(page.getByText('<primary data>')).toBeVisible();
  await expect(page.getByText(/failed to load <sub-resource>/i)).toBeVisible();
});
```

## Shared Mock Data

Mock builders live in `client/e2e/mocks/`. Spec files import builders — this avoids duplicated mock objects across specs and keeps data shapes consistent with API DTOs.

```
client/e2e/mocks/
├── <resource>.ts       # build<Item>(), build<Item>ListResponse()
├── ...                 # one file per resource type
└── index.ts            # re-exports
```

```typescript
// client/e2e/mocks/<resource>.ts — builder pattern
interface Mock<Item> {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

const DEFAULTS: Mock<Item> = {
  id: 'item-1',
  name: 'Test Item',
  status: 'Active',
  createdAt: '2026-01-01',
};

export function build<Item>(overrides?: Partial<Mock<Item>>): Mock<Item> {
  return { ...DEFAULTS, ...overrides };
}

export function build<Item>ListResponse(items?: Mock<Item>[]) {
  const data = items ?? [build<Item>()];
  return { data, total: data.length };
}
```

**When to create builders:** Create a builder file when a resource type is used by 2+ specs. For resources used by a single spec, inline mocks are acceptable — extract to a builder when a second spec needs the same shape.

## Accessibility Scanning

Use `checkA11y(page)` from fixtures in the happy path test. This is a shared helper that runs axe-core with WCAG 2.2 AA tags — one line, structural, hard to forget.

```typescript
import { test, expect, mockAuth, mockNotifications, checkA11y, SESSIONS } from './fixtures';

test('shows data on success', async ({ page }) => {
  await page.route('**/api/<resource>*', route => route.fulfill({
    status: 200, json: build<Item>ListResponse(),
  }));
  await page.goto('/<route>');
  await expect(page.getByRole('heading', { name: '<expected>' })).toBeVisible();
  await checkA11y(page);
});
```

### Managing Known Accessibility Violations

For known a11y issues that can't be fixed immediately, call `AxeBuilder` directly instead of `checkA11y` — prefer `.exclude()` (one element) over `.disableRules()` (entire rule):

```typescript
const a11yResults = await new AxeBuilder({ page })
  .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
  .exclude('#third-party-widget')
  .analyze();
expect(a11yResults.violations).toEqual([]);
```

> **Automated a11y catches only ~50% of WCAG A/AA issues** — `axe-core` is a floor, not a ceiling. A green scan is not a conformance claim; it complements, never replaces, manual keyboard and screen-reader testing.

### Scanning Dynamically Revealed Content

axe-core does not test hidden content (collapsed menus, modals, tabs). Interact with the page first to reveal the content, then scan:

```typescript
test('modal content is accessible', async ({ page }) => {
  await page.getByRole('button', { name: 'Open dialog' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  const a11yResults = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
    .include('[role="dialog"]')
    .analyze();
  expect(a11yResults.violations).toEqual([]);
});
```

### Attaching A11y Results to CI Reports

```typescript
test('shows data on success', async ({ page }, testInfo) => {
  // ... page setup and assertions ...

  const a11yResults = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
    .analyze();

  await testInfo.attach('a11y-scan-results', {
    body: JSON.stringify(a11yResults, null, 2),
    contentType: 'application/json',
  });

  expect(a11yResults.violations).toEqual([]);
});
```

## Trace Configuration for CI Debugging

Configure Playwright to capture traces on first retry of failed tests:

```typescript
// playwright.config.ts
export default defineConfig({
  use: {
    trace: 'on-first-retry',
  },
});
```

View traces locally with `npx playwright show-report` after downloading CI artifacts. For local debugging, run `npx playwright test --trace on`.

### Determinism & CI scale

- **Freeze time** with `page.clock` for anything time-dependent (relative timestamps, countdowns, token expiry). `page.clock.install()` must precede all other clock calls; prefer `setFixedTime` to freeze `Date.now()` while timers still run. Never assert against real wall-clock time.
- **Scale CI by sharding**, not by raising workers per machine: `--shard=index/total` across a CI matrix, `reporter: 'blob'` per shard, merged with `npx playwright merge-reports`. Keep `workers: 1` per shard for reproducibility.
- **CI config baseline:** `forbidOnly: !!process.env.CI`, `retries: process.env.CI ? 2 : 0`, `trace: 'on-first-retry'`.

## Flaky Test Policy (house policy)

A test is **flaky** when it fails and then passes with no code change — Playwright reports this natively as status `flaky` when a test passes on retry (run suites with `--retries=2` so flakiness is *visible* instead of silently absorbed by a manual re-run). The quarantine mechanism follows Fowler's *Eradicating Non-Determinism in Tests* (martinfowler.com/articles/nonDeterminism.html); the caps and SLA below are our policy, not industry canon.

1. **Confirm** — re-run the suspect test `npx playwright test <spec> --repeat-each=3`. All-pass or all-fail = not flaky (fix the bug or the env). Mixed = flaky.
2. **Quarantine, don't delete, don't ignore** — mark the test `test.fixme(true, 'QUARANTINED: <suspected cause> — see QUARANTINE.md')` so it stops blocking the suite, and add a row to `client/e2e/QUARANTINE.md`:
   ```markdown
   | Test | Spec file | Date | Suspected cause | Owner | Status |
   |---|---|---|---|---|---|
   | deletes item | items-list.spec.ts | 2026-06-13 | sync — assertion races mutation | <name> | open |
   ```
3. **Classify the cause** — every entry gets one of four causes, because the fix differs: **sync** (missing web-first assertion / racing a request), **locator** (fragile selector), **data** (mock or seed collision between tests), **env** (stack not healthy, port clash).
4. **Caps (hard limits)** — at most **5** quarantined tests, none older than **14 days**. Breaching either cap is an action-required finding in `/e2e-audit` and `/e2e-full`: stop adding tests and fix the quarantine backlog first.
5. **Release** — a quarantined test returns only after passing `--repeat-each=10` post-fix. Update its row to `fixed` (keep the row — it's the flake history).

**NEVER** re-run a red suite until green and move on — that converts a flaky signal into a hidden one. **NEVER** delete a flaky test to make the suite green — that converts it into zero coverage.

## Page Component Requirements

Page components must have these for E2E tests to assert properly:

- `role="status"` + `aria-label="Loading <context>"` on loading skeleton wrapper div
- Error UI with visible text (e.g., "Failed to load...") and a retry button
- `isError` + `refetch` destructured from `useApiQuery`
- Empty state with visible text (e.g., "No items found")

## Test File Structure

```
client/e2e/
├── fixtures.ts              # Shared auth/notification/a11y helpers — ALL specs import from here
├── mocks/                   # Shared mock data builders — one file per resource type
│   ├── <resource>.ts
│   └── index.ts
├── auth/
│   └── storage-state.json   # gitignored — MCP session cookies
├── integration/             # Real API tests (docker-compose.test.yml stack)
│   ├── global-setup.ts
│   └── *.spec.ts
├── <page-name>.spec.ts      # One spec per page/route
└── ...
```

## Hard Constraints

These prevent silent test failures, flaky results, or security mistakes. Violating them produces tests that pass incorrectly or break unpredictably.

- **Import from `./fixtures`**, not `@playwright/test` — the fixtures extend `test` with page error monitoring; skipping them means uncaught errors pass silently
- **Register `page.route()` before `page.goto()`** — routes set after navigation never intercept the initial request; the mock misses and the test passes against undefined data
- **End every `page.route()` handler with `route.fallback()`** for unmatched methods/paths — an unhandled request hangs until timeout with no useful error (the #1 cause of slow, opaque mocked-test failures)
- **Use web-first assertions:** `await expect(el).toBeVisible()`, not `expect(await el.isVisible()).toBe(true)` — the latter checks once with no retry and is the #1 cause of flaky tests
- **Use `mockAuth()` from fixtures**, not `localStorage`/`sessionStorage` — the app uses BFF httpOnly cookies; injecting tokens into storage does nothing
- **Use semantic locators** (`getByRole`, `getByLabel`, `getByText`), not CSS selectors or `page.locator('[role="..."]')` — CSS selectors couple tests to DOM structure and break silently on refactors
- **Use Playwright's built-in actions** (`click`, `fill`, `press`), not `fireEvent` — `fireEvent` skips browser event dispatch and misses real interaction bugs
- **Avoid `page.waitForTimeout()`** — hardcoded sleep makes tests slow and flaky; use web-first assertions or `waitForResponse`/`waitForURL` instead
- **Avoid `waitForLoadState('networkidle')`** — officially DISCOURAGED by Playwright ("Don't use this method for testing, rely on web assertions to assess readiness instead"); it waits for an arbitrary 500ms network gap and is a flake source
- **Mock third-party services with `page.route()`** — never test external services directly; they add flakiness, network dependency, and test someone else's code
- **Avoid XPath selectors** — fragile, hard to read, and couple tests to DOM structure; use semantic locators instead

## Style Guide

Positive practices that improve test quality and maintainability. Follow these consistently.

- **Assert `toHaveURL` in happy path tests** — confirms navigation completed, catches silent redirect bugs
- **Assert error state via visible text** (`getByText(/failed to load/i)`), not headings — headings may render even when the page is broken
- **Assert loading via `getByRole('status')`**, not headings or CSS class selectors — role-based loading assertions are stable across styling changes
- **Call `mockNotifications(page)` in `beforeEach`** — many pages fetch notifications in the background; an unmocked endpoint causes console errors that fail the test via the error monitor
- **Test action buttons with `waitForRequest`**, not just visibility — asserting a button exists doesn't verify it sends the right API call
- **Use mock builders from `client/e2e/mocks/`** when the same resource appears in 2+ specs — keeps mock shapes consistent and avoids drift when DTOs change
- **Call `checkA11y(page)` in the happy path test** — one-line call from fixtures catches missing labels, invalid ARIA, and contrast issues early
- **Include a mobile viewport block** for pages with responsive layout changes — verifies content remains accessible on small screens
- **Test all applicable states for the page type** — see [Page Type Classification](#page-type-classification) for what's required per type; don't force 5-state coverage on static pages
- **Test error recovery (retry)** for data pages — recovery tests are the only test level that catches broken `refetch` wiring
