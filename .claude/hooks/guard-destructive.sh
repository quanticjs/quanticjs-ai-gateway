#!/bin/bash
# PreToolUse hook: block irreversible commands.
# Exit 0 = allow, Exit 2 = block (stderr shown to Claude as feedback)
set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Force push to main/master
if echo "$COMMAND" | grep -qE "git push.*--force.*(main|master)" 2>/dev/null; then
  echo "❌ BLOCKED: Force push to main/master. This rewrites shared history permanently." >&2
  exit 2
fi

if echo "$COMMAND" | grep -qE "git push.*-f.*(main|master)" 2>/dev/null; then
  echo "❌ BLOCKED: Force push to main/master. This rewrites shared history permanently." >&2
  exit 2
fi

# git reset --hard
if echo "$COMMAND" | grep -qE "git reset --hard" 2>/dev/null; then
  echo "❌ BLOCKED: git reset --hard discards uncommitted work permanently. Use git stash or create a backup branch first." >&2
  exit 2
fi

# DROP TABLE / DROP DATABASE
if echo "$COMMAND" | grep -qiE "DROP (TABLE|DATABASE|SCHEMA)" 2>/dev/null; then
  echo "❌ BLOCKED: DROP TABLE/DATABASE/SCHEMA is irreversible. Confirm with the user before proceeding." >&2
  exit 2
fi

# rm -rf / or rm -rf .
if echo "$COMMAND" | grep -qE "rm -rf\s+(/|\.)\s*$" 2>/dev/null; then
  echo "❌ BLOCKED: Catastrophic rm -rf target." >&2
  exit 2
fi

exit 0
