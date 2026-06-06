# Fix Bug

## Process (this order is mandatory)

### Step 1: Reproduce
- Read the bug report (issue, error log, or description)
- Identify the failing behavior and expected behavior
- Find the relevant code paths

### Step 2: Regression Test FIRST
- Write a test that reproduces the bug
- Run it — **verify it fails**
- If the test passes, your test is wrong

### Step 3: Fix
- Analyze the root cause (not just the symptom)
- Implement the minimal fix
- Run the regression test — **verify it now passes**
- Run `npm run build && npm test` — verify nothing else broke

### Step 4: Commit
- Commit with message: `fix: <what-was-fixed>`

## Rules
- The regression test MUST exist before the fix
- Fix the root cause, not the symptom
- Keep the fix minimal — don't refactor surrounding code
- Follow project conventions in CLAUDE.md and `.claude/rules/`
