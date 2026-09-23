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

EGC_START='<!-- egc:start -->'
# The clean side lives next to this script (the wrapper scripts/install.sh
# writes runs it from the repository, and so does the suite); when the hook
# was installed as a link into .git/hooks, BASH_SOURCE names the link, so
# the script is looked for at the top level of the repository instead.
CLEAN_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/check-state-leak.js"
if [[ ! -f "$CLEAN_SCRIPT" ]]; then
  CLEAN_SCRIPT="$(git rev-parse --show-toplevel)/scripts/check-state-leak.js"
fi

# The paths come NUL-separated, so a name git would otherwise quote (a
# space, a character outside ASCII) reaches the commands as it is; T is in
# the filter so a file whose type changed is read too.
while IFS= read -r -d '' FILE; do
  [[ -z "$FILE" ]] && continue
  case "$FILE" in
    *.md|*.mdx|*.mdc) ;;
    *) continue ;;
  esac
  # grep reads the whole blob: a grep -q that stops at the first match closes
  # the pipe under git show, and with pipefail the test would read as false.
  if git show ":$FILE" 2>/dev/null | grep -F "$EGC_START" >/dev/null; then
    if ! command -v node >/dev/null 2>&1; then
      echo "[egc] $FILE is staged with a local state block, and node is not on the PATH to run the clean side of the commit-privacy filter, so the commit stops here and the block never reaches history. Put node on the PATH and commit again." >&2
      exit 1
    fi
    if [[ ! -f "$CLEAN_SCRIPT" ]]; then
      echo "[egc] $FILE is staged with a local state block, and the clean side of the commit-privacy filter is not at $CLEAN_SCRIPT, so the commit stops here and the block never reaches history. This hook belongs to the EGC repository: run scripts/install.sh there to put it back in place, then commit again." >&2
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
done < <(git diff --cached --name-only -z --diff-filter=ACMRT 2>/dev/null)

exit 0
