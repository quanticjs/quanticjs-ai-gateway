#!/bin/bash
# PreToolUse hook: prevent committing secrets.
# Exit 0 = allow, Exit 2 = block (stderr shown to Claude as feedback)
set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only check git add and git commit commands
if ! echo "$COMMAND" | grep -qE "git (add|commit)" 2>/dev/null; then
  exit 0
fi

ERRORS=""

# Check for .env files being staged
if echo "$COMMAND" | grep -qE "git add" 2>/dev/null; then
  if echo "$COMMAND" | grep -qE "\\.env" 2>/dev/null && ! echo "$COMMAND" | grep -qE "\\.env\\.example" 2>/dev/null; then
    ERRORS="$ERRORS\n❌ .env file being staged — contains secrets. Add to .gitignore instead."
  fi
fi

# Check staged files for secrets patterns
STAGED=$(git diff --cached --name-only 2>/dev/null)
if [[ -z "$STAGED" ]]; then
  STAGED=$(git diff --name-only 2>/dev/null)
fi

for file in $STAGED; do
  [[ -f "$file" ]] || continue
  [[ "$file" == *.ts || "$file" == *.tsx || "$file" == *.js || "$file" == *.json || "$file" == *.yaml || "$file" == *.yml ]] || continue
  [[ "$file" == *.spec.* || "$file" == *.test.* ]] && continue

  if grep -qE "(API_KEY|SECRET_KEY|PRIVATE_KEY|PASSWORD)\s*=\s*['\"][^'\"]+['\"]" "$file" 2>/dev/null; then
    ERRORS="$ERRORS\n❌ $file: Hardcoded secret detected. Use environment variables."
  fi
done

# Check for private key files
if echo "$COMMAND" | grep -qE "\\.pem|\\.key|\\.p12" 2>/dev/null; then
  ERRORS="$ERRORS\n❌ Private key file being staged. These must never be committed."
fi

if [[ -n "$ERRORS" ]]; then
  echo -e "$ERRORS" >&2
  exit 2
fi

exit 0
