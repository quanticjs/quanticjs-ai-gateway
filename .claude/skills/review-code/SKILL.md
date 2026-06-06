---
name: review-code
description: Multi-dimensional code review (quality, security, app logic) grounded in .claude/rules/. Classifies findings as Blocker, Suggestion, or Nit.
---

# Review Code — Quality, Security, Logic

Senior-engineer review across three dimensions, grounded in the project's rules in `.claude/rules/`. Every finding must cite a rule or a concrete reason, reference `file:line`, and carry a severity.

## Usage
```
/review-code                    # review all uncommitted + unpushed changes
/review-code <path>             # review a file or directory
/review-code main...HEAD        # review a branch vs main
```

## Process

### Step 1: Scope
- Default: `git diff --name-only HEAD` + `git diff --name-only main...HEAD`
- If a path/range is provided, scope the review to that
- Read every changed file in full — do NOT rely on the diff alone

### Step 2: Load Applicable Rules
Only load the rules that match the changed surface area:

| Changed area | Rules to apply |
|---|---|
| `src/**/*.ts` | `backend-patterns.md`, `database-patterns.md` (if entity/migration) |
| `client/src/**/*.{ts,tsx}` | `frontend-patterns.md` |
| `*.spec.ts` / `*.test.tsx` | `testing-patterns.md` |
| `Dockerfile*`, `docker-compose*.yml` | `docker-patterns.md` |
| Auth-related | `auth-patterns.md` |

### Step 3: Three Review Passes

#### Pass A — Code Quality
- Controllers thin? `@Validate` present? `getTransactionalRepo` used? `Result<T>` returned?
- Validation logic misplaced in handlers?
- Entity inheritance correct? camelCase columns? no duplicate `@Index`?
- `.forRoot()` modules only in `app.module.ts`?
- Frontend: React Query for server state? No tokens in localStorage? No `NodeJS.*` types?
- Dead code, `console.log`, unused imports, missing error/empty/loading states

#### Pass B — Security
- Auth: JWT guard on every non-`@Public()` route? No token returned to browser?
- Input: DTO class-validator decorators? Zod in `.validator.ts`? No raw SQL concatenation?
- Secrets: no hardcoded keys, tokens, passwords?
- Frontend XSS: no `dangerouslySetInnerHTML`? No tokens in URL params?
- Logging: no PII, tokens, or secrets in logs?

#### Pass C — Application Logic
- Does the implementation satisfy the intent?
- Transaction boundaries: multi-step writes in one UoW?
- Concurrency: race windows protected with `@DistributedLock`?
- Edge cases: empty input, pagination, null vs undefined
- Frontend: loading/empty/error states rendered? optimistic update reverts on failure?

### Step 4: Classify Every Finding

| Severity | Definition |
|---|---|
| **Blocker** | Must fix before merge. Breaks a mandatory rule, security hole, or corrupts data. |
| **Suggestion** | Should fix. Correct but suboptimal — missed caching, weak test coverage, unclear naming. |
| **Nit** | Optional polish. Style, wording, micro-refactor. |

Rules of thumb:
- If a `.claude/rules/` file says **NEVER** or **MANDATORY** → Blocker
- If it is a **security** or **data-integrity** concern → Blocker
- If behavior is correct but surprising to a future reader → Suggestion
- If removing the finding wouldn't change approval → Nit

### Step 5: Output

```
## Code Review — <scope>

**Files reviewed:** N   **Passes:** Quality · Security · Logic

---

### BLOCKERS (must fix) — <count>

1. `file:line` · Dimension · rule reference
   One-line description and fix.

### SUGGESTIONS (should fix) — <count>

2. `file:line` · Dimension
   One-line description.

### NITS (optional) — <count>

3. `file:line` · Dimension
   One-line description.

---

### Verdict
- **N Blockers** — do not merge until resolved
- **M Suggestions** — address in this PR if cheap
- **K Nits** — author's discretion
```

## Rules
- NEVER invent a rule — every Blocker cites `.claude/rules/` or a concrete security reason
- NEVER mark a style preference as Blocker
- NEVER review files you haven't read in full
- Keep each finding to 1-2 sentences
