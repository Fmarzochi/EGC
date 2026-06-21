#!/usr/bin/env bash
# Strips egc:state blocks from staged markdown files before commit.
# The working tree is left untouched — IDEs continue reading local project memory normally.

set -euo pipefail

if [[ "${EGC_SKIP_GIT_HOOKS:-0}" == "1" || "${EGC_SKIP_PRECOMMIT:-0}" == "1" ]]; then
  exit 0
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

STAGED=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null) || true
[ -z "$STAGED" ] && exit 0

EGC_START='<!-- egc:start -->'
EGC_END='<!-- egc:end -->'

while IFS= read -r FILE; do
  [ -z "$FILE" ] && continue
  case "$FILE" in
    *.md|*.mdx|*.mdc) ;;
    *) continue ;;
  esac
  if git show ":$FILE" 2>/dev/null | grep -qF "$EGC_START"; then
    CLEAN_HASH=$(git show ":$FILE" | sed "/^${EGC_START}$/,/^${EGC_END}$/d" | git hash-object -w --stdin)
    MODE=$(git ls-files --stage "$FILE" | awk '{print $1}')
    git update-index --cacheinfo "${MODE},${CLEAN_HASH},${FILE}"
    echo "[egc] stripped local state block from $FILE"
  fi
done <<< "$STAGED"

exit 0
