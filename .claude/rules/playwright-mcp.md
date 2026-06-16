---
globs: "client/e2e/**/*.ts, client/playwright*.config.ts, .mcp.json"
---

# Playwright MCP — Browser Control for Claude Code

You have a Playwright MCP server giving you **real-time browser control** — navigate pages, click elements, fill forms, and take screenshots without writing test files.

> **The Playwright MCP server is provided by the `quanticjs-hooks` plugin** (a `.mcp.json` at the plugin root, pinned to a specific `@playwright/mcp` version). Any project that enables the plugin gets it automatically — **you do not create a per-project `.mcp.json`.** Claude Code prompts to approve the plugin-provided server on first load; approve it once and the `browser_*` tools become available.
>
> - **To verify** it's wired: the `browser_*` MCP tools are present in the session. If they're absent, the plugin isn't enabled/approved or its cached version predates this config — run `/plugin` and update `quanticjs-hooks`.
> - **To pin a different version** for one project, add a root `.mcp.json` (NOT `.claude/mcp.json`) — a project-scoped server shadows the plugin's by name:
>   ```json
>   { "mcpServers": { "playwright": { "type": "stdio", "command": "npx", "args": ["@playwright/mcp@0.0.75"] } } }
>   ```
> - **Never** put MCP config in `.claude/mcp.json` or an `mcpServers` key in `.claude/settings.json` — Claude Code does not read those paths; the config is silently ignored, `browser_*` never loads, and MCP-dependent skills (`/e2e-full`, `/int-full`, `/e2e-verify`) fail their Phase 0 preflight with "no Playwright MCP toolchain configured".

This rule covers UI E2E (`playwright.config.ts`, mocked APIs); integration E2E uses `playwright.integration.config.ts` (see `testing-integration.md`).

**State "using Playwright MCP" in your first message of an MCP session** — otherwise Claude may default to Bash-driven Playwright commands instead of the MCP tools.

## Setup & Version Pinning

- **Package:** Microsoft's `@playwright/mcp` — **NOT** the community `@executeautomation/playwright-mcp-server`. Do not confuse them.
- **Pin the version** in the `quanticjs-hooks` plugin's root `.mcp.json` (the single source of truth for all consumers). Never use `@latest` in shared configs — beta releases silently break tool schemas mid-session. Bumping the pin is a plugin release: edit it there, bump the plugin version, publish, and consumers pick it up via `/plugin` update.
- **Node 18+ required.** Older versions throw `performance is not defined`. Verify with `node --version` before any MCP run.
- **Install browser binaries** after any version bump: `npx playwright install` (and `npx playwright install-deps` on Linux/CI).
- **Smoke test** after setup: `browser_navigate` to `http://localhost:5173/` and confirm the a11y tree returns.

## CI / Headless

- Pass `--headless` to the MCP server args when running in CI or Docker — default is headed.
- For repeatable CI runs, prefer coded specs (`client/e2e/`) over MCP. Use MCP for exploration and debugging, not pipeline execution.

## Positioning — discover & author, never gate CI

Playwright MCP is for **exploration and authoring**, not regression. It is non-deterministic (every tool call is an LLM inference step), amplifies environmental noise, and has limited network mocking — so it must **never** be the CI/regression gate. The sanctioned flow:

```
MCP → discover the journey / verify visually / draft or repair a spec
    → hand off to a coded Playwright spec (client/e2e/) → that spec gates CI
```

`/e2e-verify` / `/int-verify` output is an **input to authoring**, never the pass/fail gate. Keep MCP pointed at the local dev/test stack only (every page's DOM/console is sent to the model — no real user data).

## Authoring Engine — Playwright Official Test Agents (canonical)

The canonical way to author and maintain coded browser-E2E specs is Playwright's **official test agents**, not bespoke per-project authoring logic. Scaffold them once per app:

```bash
npx playwright init-agents --loop=claude
```

This generates three MCP-wired agents (regenerated on each Playwright upgrade — don't hand-edit them):

| Agent | Does | Supersedes |
|---|---|---|
| **🎭 Planner** | Explores the live app via MCP, writes a Markdown plan in `specs/` (uses `seed.spec.ts` for setup/auth) | bespoke MCP journey walks |
| **🎭 Generator** | Turns a `specs/*.md` plan into `.spec.ts` under `tests/`, verifying every selector live as it writes | bespoke spec writing |
| **🎭 Healer** | Replays a failing test against the current UI and patches it | bespoke heal logic |

Generated specs back-reference their plan (`// spec: specs/...`, `// seed: tests/seed.spec.ts`) for requirement→test traceability. `seed.spec.ts` is where the auth setup-project / `storageState` plugs in (see `testing-integration.md`).

**What the official agents do NOT cover — keep these as project governance on top:**

- **Coverage discovery** — the Planner authors from a request/PRD, not a codebase gap scan. `/e2e-scan` (route matrix, `COVERAGE.md`) feeds it targets.
- **Project conventions** — the generic agents don't know your rules. The 5-state model, shared `fixtures.ts`, semantic-locator priority, and mock boundary live in this repo's rules + `seed.spec.ts`, and in `write-ui-tests` (the convention spec the Generator follows).
- **Governance & non-browser layers** — quarantine policy, the a11y axe phase, fidelity scoring, the backend `int-*` Jest suite, and `write-workflow-tests` are out of scope for the browser agents. `/e2e-full` / `/int-full` orchestrate them around the agents.

### Heal policy (governs the Healer)

Left alone, the official Healer **skips** a test when functionality looks broken — a silent outcome that lets real regressions rot. Override it with this policy:

- **Heal only test drift** — drifted selectors/assertions, patched from the live `browser_snapshot` or the DTO/`Result` contract.
- **A genuine app regression is reported loudly, never skipped or healed** — editing or skipping a test to hide a real failure is the cycle of self-deception (`testing-patterns.md`). The test stays red; fix the app.
- **A patched test must still be able to fail** — confirm by briefly breaking its expectation.

Backend integration specs (`int-*`, Jest) are not browser tests — the Playwright agents don't touch them; the same heal policy applies, driven by Claude against the contract.

## Two Uses

### 1. Visual Self-QA (during implementation)
After implementing UI changes, open the page and verify it renders correctly:
- `browser_navigate` to the page → `browser_snapshot` (content) or `browser_screenshot` (visual layout) → check it looks right
- Use during any issue that touches `.tsx` files

### 2. E2E Journey Verification (via `/e2e-verify`)
Walk through full user journeys by browsing the app interactively. This replaces hardcoded Playwright spec files for UI verification. The journey definitions live in the `/e2e-verify` skill (`e2e-verify/SKILL.md`, alongside `e2e-scan` in the scaffolding plugin) — `/e2e-scan` writes them there.

## MCP Tools

- `browser_navigate` — open a URL
- `browser_click` — click an element
- `browser_fill` — type into an input
- `browser_snapshot` — return the accessibility tree (~120 tokens, stable selectors)
- `browser_screenshot` — capture a visual screenshot (~1,500 tokens)
- `browser_select_option`, `browser_hover`, `browser_drag`, etc.

## Snapshot vs Screenshot

Prefer `browser_snapshot` for element discovery, interaction, and content verification — it returns the accessibility tree, costs ~12x fewer tokens than a screenshot, and provides more stable element references.

Use `browser_take_screenshot` only when verifying **visual appearance** (colors, layout, spacing, images).

## Authenticated Pages

Most pages require login. The app uses BFF httpOnly cookies — not sessionStorage tokens.

Run `cd client && npx tsx ../scripts/save-auth-state.ts` first (requires Docker stack up). This completes the BFF OIDC login flow through Keycloak and saves the resulting httpOnly session cookie to a **gitignored** path (`client/e2e/auth/storage-state.json`).

> **This script is not committed to most apps by default.** If `scripts/save-auth-state.ts` doesn't exist (or `docker-compose.test.yml` has no Keycloak service), run the `/setup-e2e-stack` skill once — it generates the script from the canonical plugin template, gitignores the auth dir, and adds Keycloak to the test stack. Don't hand-write it.

If pages redirect to the login page, the storage state is expired — re-run the save script.

> The `save-auth-state.ts` script is for **MCP exploration only**. The coded **test suite** authenticates via the setup-project / `outputDir` pattern instead (see `testing-integration.md`) so the state file lives in the gitignored output dir and cannot be committed.

## Ports

### Dev Stack (visual self-QA during development)

| Service | URL | When |
|---------|-----|------|
| Vite dev server | `http://localhost:5173` | `cd client && npm run dev` |
| Backend API | `http://localhost:3000` | `docker compose up` |
| Keycloak | `http://localhost:8080` | `docker compose up` |

### Test Stack (E2E skills: `/e2e-full`, `/e2e-verify`, `/e2e-audit`)

Ports: this app's per-app band (`8N99`/`3N99`/`5N99`) — see the Per-App Port Band scheme in `testing-integration.md` (`docker compose -f docker-compose.test.yml up`). Start the test Vite against the band: `cd client && VITE_API_URL=http://localhost:${TEST_API_PORT:-3199} npm run dev -- --port ${TEST_WEB_PORT:-5199}`.

**E2E tests MUST use the test stack** — never the dev stack.

## Do NOT

- Do not commit `client/e2e/auth/storage-state.json` — it contains httpOnly session cookies
- Do not use MCP for API contract assertions (status codes, JSON payloads) — use coded tests for those
- Do not use MCP as a replacement for the mocked UI E2E suite (`client/e2e/`) — MCP is for exploratory/visual verification only
- Do not point MCP at environments with real user data. Every page's DOM, console output, and form values get transmitted to Anthropic's API — keep MCP restricted to the local dev stack
- Do not use `@playwright/mcp@latest` — pin a specific version in the `quanticjs-hooks` plugin's root `.mcp.json`
- Do not hand-create a per-project `.mcp.json` for Playwright — the `quanticjs-hooks` plugin provides it; only add a root `.mcp.json` to override the pinned version for one project
- Do not put the MCP server config in `.claude/mcp.json` or `.claude/settings.json` — Claude Code does not read those for MCP servers; use `.mcp.json` at the repo root (or rely on the plugin)
- Do not install `@executeautomation/playwright-mcp-server` thinking it's the same package — it isn't
