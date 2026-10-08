#!/usr/bin/env bash
# scan.sh: enumerate skill files, extract frontmatter and UTC mtime
# Usage: scan.sh [CWD_SKILLS_DIR]
# Output: JSON to stdout
#
# When CWD_SKILLS_DIR is omitted, defaults to the project skills folder:
# $PWD/.agents/skills, or the first of the other project tool folders
# (fixed order, not the tool the session runs inside) that has one.
#
# Environment:
#   SKILL_STOCKTAKE_GLOBAL_DIR   Override the global skills folder of the EGC
#                                directory in use (for testing only;
#                                do not set in production: intended for bats tests)
#   SKILL_STOCKTAKE_PROJECT_DIR  Override project dir detection (for testing only)
#   SKILL_STOCKTAKE_OBSERVATIONS One observations file, or a folder scanned for
#                                every observations.jsonl (default: ~/.egc-learning)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=egc-paths.sh
source "$SCRIPT_DIR/egc-paths.sh"

GLOBAL_DIR="${SKILL_STOCKTAKE_GLOBAL_DIR:-$(egc_global_skills_dir "$SCRIPT_DIR")}"
CWD_SKILLS_DIR="${SKILL_STOCKTAKE_PROJECT_DIR:-${1:-$(egc_project_skills_dir "$PWD")}}"
# Tool-use observations (optional; used for usage frequency counts): one JSONL
# file, or the learning store, where continuous-learning-v2 keeps one
# observations.jsonl per project.
OBSERVATIONS="${SKILL_STOCKTAKE_OBSERVATIONS:-$HOME/.egc-learning}"

# Validate CWD_SKILLS_DIR looks like a skills path (defense-in-depth).
# Only warn when the path exists: a nonexistent path poses no traversal risk.
if [[ -n "$CWD_SKILLS_DIR" && -d "$CWD_SKILLS_DIR" && "$CWD_SKILLS_DIR" != */skills ]]; then
  echo "Warning: CWD_SKILLS_DIR does not look like a skills path: $CWD_SKILLS_DIR" >&2
fi

# Every observation line: from the one file, or from each observations.jsonl
# under the folder.
observation_lines() {
  local file
  if [[ -f "$OBSERVATIONS" ]]; then
    cat "$OBSERVATIONS"
  elif [[ -d "$OBSERVATIONS" ]]; then
    while IFS= read -r file; do
      cat "$file"
    done < <(find "$OBSERVATIONS" -name 'observations.jsonl' -type f 2>/dev/null | sort)
  fi
}

# Extract a frontmatter field (handles both quoted and unquoted single-line values).
# Does NOT support multi-line YAML blocks (| or >) or nested YAML keys.
extract_field() {
  local file="$1" field="$2"
  awk -v f="$field" '
    BEGIN { fm=0 }
    /^---$/ { fm++; next }
    fm==1 {
      n = length(f) + 2
      if (substr($0, 1, n) == f ": ") {
        val = substr($0, n+1)
        gsub(/^"/, "", val)
        gsub(/"$/, "", val)
        print val
        exit
      }
    }
    fm>=2 { exit }
  ' "$file"
}

# Get UTC timestamp N days ago (supports both macOS and GNU date)
date_ago() {
  local n="$1"
  date -u -v-"${n}d" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
  date -u -d "${n} days ago" +%Y-%m-%dT%H:%M:%SZ
}

# The path a Read observation names. continuous-learning-v2's observe.sh
# (the real writer of ~/.egc-learning/.../observations.jsonl) never puts a
# top-level path on the record: a "tool_start" event carries the tool_input
# it was given, JSON-encoded, in .input; the matching "tool_complete" event
# carries no input at all. A record with a top-level .path (another writer,
# or a future format) is read directly. Neither shape carries a timestamp,
# so a record without one counts in every window: there is no way to tell
# a stale read from a fresh one, and showing 0 would be the wrong default.
OBS_PATH_FILTER='select(.tool=="Read") | (.path // (if .event=="tool_start" then (.input | try fromjson catch null).file_path else null end)) as $p | select($p != null) | {path: $p, in_window: ((.timestamp // $c) >= $c)}'

# Scan a directory and produce a JSON array of skill objects
scan_dir_to_json() {
  local dir="$1"
  local c7 c30
  c7=$(date_ago 7)
  c30=$(date_ago 30)

  local tmpdir
  tmpdir=$(mktemp -d)
  # Use a function to avoid embedding $tmpdir in a quoted string (prevents injection
  # if TMPDIR were crafted to contain shell metacharacters).
  local _scan_tmpdir="$tmpdir"
  _scan_cleanup() { rm -rf "$_scan_tmpdir"; }
  trap _scan_cleanup RETURN

  # Pre-aggregate observation counts in two passes (one per window) instead of
  # calling jq per-file: reduces from O(n*m) to O(n+m) jq invocations.
  local obs_7d_counts obs_30d_counts obs_lines
  obs_7d_counts=""
  obs_30d_counts=""
  obs_lines=$(observation_lines)
  if [[ -n "$obs_lines" ]]; then
    obs_7d_counts=$(echo "$obs_lines" | jq -r --arg c "$c7" \
      "$OBS_PATH_FILTER | select(.in_window) | .path" \
      2>/dev/null | sort | uniq -c)
    obs_30d_counts=$(echo "$obs_lines" | jq -r --arg c "$c30" \
      "$OBS_PATH_FILTER | select(.in_window) | .path" \
      2>/dev/null | sort | uniq -c)
  fi

  local i=0
  while IFS= read -r file; do
    local name desc mtime u7 u30 dp
    name=$(extract_field "$file" "name")
    desc=$(extract_field "$file" "description")
    mtime=$(date -u -r "$file" +%Y-%m-%dT%H:%M:%SZ)
    # Use awk exact field match to avoid substring false-positives from grep -F.
    # uniq -c output format: "   N /path/to/file": path is always field 2.
    u7=$(echo "$obs_7d_counts" | awk -v f="$file" '$2 == f {print $1}' | head -1)
    u7="${u7:-0}"
    u30=$(echo "$obs_30d_counts" | awk -v f="$file" '$2 == f {print $1}' | head -1)
    u30="${u30:-0}"
    dp="$file"
    [[ "$file" == "${HOME%/}/"* ]] && dp="~${file#"${HOME%/}"}"

    jq -n \
      --arg path "$dp" \
      --arg name "$name" \
      --arg description "$desc" \
      --arg mtime "$mtime" \
      --argjson use_7d "$u7" \
      --argjson use_30d "$u30" \
      '{path:$path,name:$name,description:$description,use_7d:$use_7d,use_30d:$use_30d,mtime:$mtime}' \
      > "$tmpdir/$i.json"
    i=$((i+1))
  done < <(find "$dir" -name "*.md" -type f 2>/dev/null | sort)

  if [[ $i -eq 0 ]]; then
    echo "[]"
  else
    jq -s '.' "$tmpdir"/*.json
  fi
}

# --- Main ---

global_found="false"
global_count=0
global_skills="[]"

if [[ -d "$GLOBAL_DIR" ]]; then
  global_found="true"
  global_skills=$(scan_dir_to_json "$GLOBAL_DIR")
  global_count=$(echo "$global_skills" | jq 'length')
fi

project_found="false"
project_path=""
project_count=0
project_skills="[]"

if [[ -n "$CWD_SKILLS_DIR" && -d "$CWD_SKILLS_DIR" ]]; then
  project_found="true"
  project_path="$CWD_SKILLS_DIR"
  project_skills=$(scan_dir_to_json "$CWD_SKILLS_DIR")
  project_count=$(echo "$project_skills" | jq 'length')
fi

# Merge global + project skills into one array
all_skills=$(jq -s 'add' <(echo "$global_skills") <(echo "$project_skills"))

jq -n \
  --arg global_found "$global_found" \
  --argjson global_count "$global_count" \
  --arg project_found "$project_found" \
  --arg project_path "$project_path" \
  --argjson project_count "$project_count" \
  --argjson skills "$all_skills" \
  '{
    scan_summary: {
      global: { found: ($global_found == "true"), count: $global_count },
      project: { found: ($project_found == "true"), path: $project_path, count: $project_count }
    },
    skills: $skills
  }'
