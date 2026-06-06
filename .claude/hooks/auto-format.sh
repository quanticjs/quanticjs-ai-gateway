#!/bin/bash
# PreToolUse hook: auto-format staged files before commit.
# Exit 0 = allow (formatting is best-effort, never blocks commit).
set -uo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only run on git commit
if ! echo "$COMMAND" | grep -qE "git commit" 2>/dev/null; then
  exit 0
fi

# Format staged .ts/.tsx/.js/.jsx files
FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep -E '\.(tsx?|jsx?)$' || true)

if [[ -n "$FILES" ]]; then
  echo "$FILES" | xargs npx prettier --write >/dev/null 2>&1 || true
  echo "$FILES" | xargs git add 2>/dev/null || true
fi

exit 0
