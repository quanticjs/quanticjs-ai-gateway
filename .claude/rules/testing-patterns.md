---
globs: "src/**/*.spec.ts, src/**/*.test.ts, client/src/**/*.test.{ts,tsx}, client/e2e/**"
---

# Testing Patterns

## Assertions Come From the Contract, Not the Implementation (READ FIRST)

When a skill (or you) authors a test, the most dangerous failure mode is the **cycle of self-deception**: write the code, then write a test that asserts *what the code already does*. The test passes, proves nothing, and locks in the bug. If the requirement is a 15% discount and the handler computes 10%, a test derived from the handler asserts 10% — green and wrong. This is the #1 way AI-generated tests fail.

**Derive every assertion from the requirement, spec, journey, or DTO/`Result` contract — never from reading the implementation under test.**

- Expected values come from the acceptance criteria / spec file / API contract — not from running the code and copying its output.
- When generating a test for existing code that has no written spec, state the expected behavior **first** (in the test name and a leading comment), then assert it. If you cannot state it without reading the implementation, the behavior is unspecified — flag it; do not invent an assertion that mirrors the code.
- A generated test that has never actually run is not done. Run it (every `write-*-tests` skill ends with a Verify step) and confirm two things: it passes for the right reason, **and** a deliberately broken expectation makes it fail. A test that cannot fail is not a test.
- The author of a test should not be its only reviewer. Prefer a fresh-context pass (`/review-code`) over self-grading.

## Backend — Three Layers

### Unit Tests (Jest)

Test handlers, validators, and utilities in isolation.

Every handler test must cover: happy path, validation failure, not found, conflict, permission check.

Validator tests are mandatory and separate.

### Integration Tests (Jest + Supertest)

Full HTTP → Controller → Pipeline → Handler → Database round trips.

**Real database, not mocks.** Run against PostgreSQL via `docker-compose.test.yml`.

Isolated test-stack ports follow this app's per-app band (`3N99`/`8N99`/`5N99`, e.g. N=1: `3199`/`8199`/`5199`) — see the Per-App Port Band scheme in `testing-integration.md`.

### E2E Tests

Isolated test stack: `docker-compose.test.yml` on this app's per-app band (API `3N99`, Keycloak `8N99` — see the Per-App Port Band scheme in `testing-integration.md`).

### `@quanticjs/testing` Reference

The package exports exactly: `TestingModuleFactory`, `createMockRepository`, `createMockRedisClient`, and the type `TestingModuleOptions` (`{ providers?, entities?, overrides?, withPipeline? }` — `withPipeline: true` wires Log/Validation behaviors + registry + patched buses). `createMockRedisClient` covers string commands, stream commands, and `duplicate()`.

## Frontend — Three Layers

### Component Tests (Vitest + React Testing Library)

Test user-visible behavior, not implementation details.

**Query priority:** `getByRole` > `getByLabelText` > `getByText` > `getByTestId` (last resort).

**Every component test must cover:** happy path, loading state, error state, empty state, user interactions.

```typescript
it('renders item name', () => {
  render(<ItemCard item={{ id: '1', name: 'Test' }} />);
  expect(screen.getByRole('heading', { name: 'Test' })).toBeInTheDocument();
});
```

### Hook Tests (Vitest + TanStack Query)

Test custom hooks with a real QueryClient. Use MSW for API mocking.

**Auth mocking:**
```typescript
// ✅ CORRECT
queryClient.setQueryData(['auth', 'session'], { keycloakId: 'test-id', roles: ['user'] });

// ❌ WRONG
localStorage.setItem('access_token', 'fake-jwt');
```

### E2E Tests (Playwright)

Mock APIs via `page.route()`. Every spec covers 5 states:

| State | Mock |
|-------|------|
| Happy path | API returns 200 + `toHaveURL` + axe-core scan |
| Error | API returns 500 |
| Error recovery | Click retry → API returns 200 |
| Empty | API returns 200 + empty array |
| Loading | Delay API response |

Pages with forms/actions must also test mutations with `waitForRequest`.

Auth mocking in E2E: use the `mockAuth()` fixture — pattern and presets in `testing-e2e-ui.md` (mandatory).

**Mock data** — use shared builders from `client/e2e/mocks/`, NEVER inline objects.

**Responsive testing:** Every spec must include a mobile viewport block (375×812).

See `testing-e2e-ui.md` for complete patterns and NEVER list.

## Accessibility in E2E

Every page must have at least one `@axe-core/playwright` test:

```typescript
import AxeBuilder from '@axe-core/playwright';
test('page has no a11y violations', async ({ page }) => {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  expect(results.violations).toEqual([]);
});
```

## Linting E2E Tests

Enable `@typescript-eslint/no-floating-promises` in ESLint for test files. A missing `await` on a Playwright assertion silently passes without waiting — the most common cause of flaky E2E tests.

```typescript
// ❌ FLAKY — missing await, assertion never retries
expect(page.getByText('welcome')).toBeVisible();

// ✅ CORRECT — await triggers Playwright's auto-retry
await expect(page.getByText('welcome')).toBeVisible();
```

## CI Pipeline & Quality Gates

CI stages: see the CI/CD pipeline design doc (canonical stage list — backend build/lint/test:cov/test:integration plus the AllowAnonymous and x-tenant-id guards, detailed in `auth-patterns.md`; UI repos run UI E2E in PR + nightly full-stack system E2E).

Branch protection requires all jobs. Merges are **squash-only**, and PR titles are validated as **conventional commits** in CI — the squashed title becomes the `main` commit message that feeds `conventional-changelog`. No commitlint/husky on individual commits.

### Coverage

- 80% line coverage enforced in CI: `coverageThreshold: { global: { lines: 80 } }` — **lines only**, deliberately no branches/functions/statements thresholds. CI runs `test:cov`; local `test` stays fast.
- Packages below 80 carry a temporary per-package ratchet (`{ global: { lines: <current> } }` + `TODO(v7.x)`); raise toward 80, **never lower**.
- Exempt packages live in the coverage config: only via per-package `coverageThreshold: { global: {} }`, reserved for the documented zero-logic packages (`quanticjs`, `testing`, `files-client`); any exemption change must update the documented exempt list **in the same PR**.
- `collectCoverageFrom` must exclude `*.spec.ts`, `*.d.ts`, `dist/`, `node_modules/`, and barrel `index.ts` files — don't pad the denominator.
- `--passWithNoTests` is allowed **only** in the documented zero-test packages (`quanticjs`, `testing`); everywhere else zero discovered tests must FAIL the test script.

### Lint Gate Must Be Real

Every package needs a real `lint` script and a resolvable flat config (a `lint` that exits 0 with no config is a no-op gate), including:

- `no-restricted-imports` banning `@quanticjs/*/src/*` and `@quanticjs/*/dist/*` (barrel imports only)
- `no-console: 'error'`
- `no-unused-vars` with the `_` prefix escape
- `no-explicit-any`: warn in `src/`, **off in spec files** — the spec override glob is `['**/*.spec.ts', '**/*.integration-spec.ts', '**/__mocks__/**']` and also disables `no-non-null-assertion` (`as any` mocks and `result.value!` in tests are sanctioned)

### Monorepo (Turbo) Hygiene

- Shared root configs (`eslint.config.mjs`, `jest.config.base.js`, root `__mocks__/`) must be `$TURBO_ROOT$` inputs of lint/test tasks — config changes hit stale caches otherwise.
- Turbo silently skips missing scripts: CI must assert every package declares `lint`, `test`, `test:cov`.

### Prometheus Registry Isolation in Jest

Tests touching metrics MUST pass a fresh `Registry` (via the `METRICS_REGISTRY` token / constructor arg) or call `register.clear()` in `afterEach` — the prom-client global registry survives across tests and re-boots.

## NEVER

- **NEVER** test implementation details (internal state, private methods, CSS classes)
- **NEVER** use CSS selectors or `page.locator('[role="..."]')` in E2E tests — use `getByRole`/`getByText`
- **NEVER** use `page.waitForTimeout()` — use web-first assertions
- **NEVER** use `fireEvent` — use `userEvent`
- **NEVER** mock the database in integration tests
- **NEVER** use `localStorage`/`sessionStorage` for auth in tests
- **NEVER** inline auth mocking in E2E — use `mockAuth()` from shared fixtures
- **NEVER** define mock objects inline in E2E specs — use builders from `client/e2e/mocks/`
- **NEVER** write happy-path-only tests — all 5 states mandatory (happy, error, recovery, empty, loading)
- **NEVER** only assert action buttons are visible — test clicking them
- **NEVER** use `setTimeout`/`waitForTimeout` for timing in tests
- **NEVER** use `expect(await el.isVisible()).toBe(true)` — use `await expect(el).toBeVisible()` (auto-retrying)
- **NEVER** mock React built-in hooks (`useState`, `useEffect`) — test through real components
- **NEVER** add blanket `--passWithNoTests` to test scripts — zero discovered tests must fail outside documented zero-test packages
- **NEVER** ship a `lint` script that exits 0 without a resolvable ESLint config — a no-op gate is worse than no gate
- **NEVER** assert on 500 response `detail` text — masked in production; correlate via `correlationId` (see `api-patterns.md`)
- **NEVER** derive a test's expected values by reading the implementation under test — assert the requirement/spec/contract (the "cycle of self-deception"); a test that only confirms what the code currently does is worthless
- **NEVER** mark a generated test complete without running it and confirming it fails when its expectation is deliberately broken — an unrun or unfailable test is not coverage
