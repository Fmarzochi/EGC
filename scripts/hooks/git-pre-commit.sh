#!/usr/bin/env bash
# Cleans the egc:state block of a staged context file to the skeleton the
# commit-privacy filter keeps (the markers, the heading and the notice stay,
# the memory goes), through the same clean function the filter runs, so the
# committed form is one. The working tree is left untouched: the tools keep
# reading the local project memory from it.

set -euo pipefail

if [[ "${EGC_SKIP_GIT_HOOKS:-0}" == "1" || "${EGC_SKIP_PRECOMMIT:-0}" == "1" ]]; then
  exit 0
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

STAGED=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null) || true
[[ -z "$STAGED" ]] && exit 0

EGC_START='<!-- egc:start -->'
CLEAN_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/check-state-leak.js"

while IFS= read -r FILE; do
  [[ -z "$FILE" ]] && continue
  case "$FILE" in
    *.md|*.mdx|*.mdc) ;;
    *) continue ;;
  esac
  # grep reads the whole blob: a grep -q that stops at the first match closes
  # the pipe under git show, and with pipefail the test would read as false.
  if git show ":$FILE" 2>/dev/null | grep -F "$EGC_START" >/dev/null; then
    if ! command -v node >/dev/null 2>&1 || [[ ! -f "$CLEAN_SCRIPT" ]]; then
      echo "[egc] $FILE is staged with a local state block, and the clean side of the commit-privacy filter (node and scripts/check-state-leak.js) is not at hand to take the memory out, so the commit stops here and the block never reaches history. Put node on the PATH and commit again." >&2
      exit 1
    fi
    CLEAN_HASH=$(git show ":$FILE" | node "$CLEAN_SCRIPT" --filter-clean | git hash-object -w --stdin)
    ENTRY=$(git ls-files --stage "$FILE")
    MODE=$(echo "$ENTRY" | awk '{print $1}')
    STAGED_HASH=$(echo "$ENTRY" | awk '{print $2}')
    if [[ "$CLEAN_HASH" != "$STAGED_HASH" ]]; then
      git update-index --cacheinfo "${MODE},${CLEAN_HASH},${FILE}"
      echo "[egc] the local state block of $FILE was cleaned to its skeleton for the commit; the working tree keeps the memory"
    fi
  fi
done <<< "$STAGED"

exit 0
