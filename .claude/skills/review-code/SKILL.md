# Review Code — Quality, Security, Logic

Senior-engineer review grounded in `.claude/rules/`.

## Usage
```
/review-code                    # review all uncommitted + unpushed changes
/review-code <path>             # review a file or directory
```

## Process

### Step 1: Scope
- Default: `git diff --name-only HEAD` + `git diff --name-only main...HEAD`
- Read every changed file in full

### Step 2: Load Applicable Rules
| Changed area | Rules to apply |
|---|---|
| `src/**/*.ts` | `backend-patterns.md`, `resilience-ops.md`, `observability-backend.md` |
| `Dockerfile*`, `docker-compose*.yml` | `docker-patterns.md` |

### Step 3: Three Review Passes

#### Pass A — Code Quality
- Controllers thin? `@Validate` present? `Result<T>` returned?
- Validation in handlers? (BLOCKER)
- Circuit breaker on every external HTTP call?
- Metrics recorded in handlers?
- `.forRoot()` modules only in `app.module.ts`?

#### Pass B — Security
- No hardcoded API keys, tokens, passwords?
- No secrets in logs?
- Input validation on DTOs (class-validator) and commands (Zod)?

#### Pass C — Application Logic
- Does the implementation satisfy the intent?
- Timeout on all outbound HTTP calls?
- Circuit breaker state tracked in metrics?
- Edge cases: empty input, large batches

### Step 4: Classify
| Severity | Definition |
|---|---|
| **Blocker** | Must fix. Breaks a mandatory rule, security hole. |
| **Suggestion** | Should fix. Correct but suboptimal. |
| **Nit** | Optional polish. |

## Rules
- NEVER invent a rule — cite `.claude/rules/`
- NEVER mark style as Blocker
- NEVER review files you haven't read in full
