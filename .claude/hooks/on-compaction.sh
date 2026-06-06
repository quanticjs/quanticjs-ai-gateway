#!/bin/bash
# Notification hook: fires after context compaction.
# Re-injects key context so Claude doesn't lose track of current work.
set -uo pipefail

echo "=== POST-COMPACTION CONTEXT ==="

BRANCH=$(git branch --show-current 2>/dev/null)
if [[ -n "$BRANCH" ]]; then
  echo "Branch: $BRANCH"
fi

COMMITS=$(git log --oneline -10 main..HEAD 2>/dev/null)
if [[ -n "$COMMITS" ]]; then
  echo ""
  echo "Commits on this branch:"
  echo "$COMMITS"
fi

CHANGES=$(git status --short 2>/dev/null | head -20)
if [[ -n "$CHANGES" ]]; then
  echo ""
  echo "Uncommitted changes:"
  echo "$CHANGES"
fi

echo ""
echo "Re-read CLAUDE.md and .claude/rules/ for conventions."
echo "=== END ==="
