#!/bin/bash
# Continuous Learning - Session Evaluator
# Runs on Stop hook to extract reusable patterns from AI coding sessions
#
# Why Stop hook instead of UserPromptSubmit:
# - Stop runs once at session end (lightweight)
# - UserPromptSubmit runs every message (heavy, adds latency)
#
# Hook config (in ~/.gemini/settings.json):
# {
#   "hooks": {
#     "Stop": [{
#       "matcher": "*",
#       "hooks": [{
#         "type": "command",
#         "command": "~/.gemini/skills/continuous-learning/evaluate-session.sh"
#       }]
#     }]
#   }
# }
#
# Patterns to detect: error_resolution, debugging_techniques, workarounds, project_specific
# Patterns to ignore: simple_typos, one_time_fixes, external_api_issues
# Extracted skills saved to: ~/.gemini/skills/learned/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.json"
LEARNED_SKILLS_PATH="${HOME}/.gemini/skills/learned"
MIN_SESSION_LENGTH=10

if [ -f "$CONFIG_FILE" ]; then
  if ! command -v jq &>/dev/null; then
    echo "[ContinuousLearning] jq is required to parse config.json but not installed, using defaults" >&2
  else
    MIN_SESSION_LENGTH=$(jq -r '.min_session_length // 10' "$CONFIG_FILE")
    LEARNED_SKILLS_PATH=$(jq -r '.learned_skills_path // "~/.gemini/skills/learned/"' "$CONFIG_FILE" | sed "s|~|$HOME|")
  fi
fi

mkdir -p "$LEARNED_SKILLS_PATH"

# Falls back to env var for backwards compatibility
stdin_data=$(cat)
transcript_path=$(echo "$stdin_data" | grep -o '"transcript_path":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$transcript_path" ]; then
  transcript_path="${GEMINI_TRANSCRIPT_PATH:-}"
fi

if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
  exit 0
fi

# Count messages in session
message_count=$(grep -c '"type":"user"' "$transcript_path" 2>/dev/null || echo "0")

# Skip short sessions
if [ "$message_count" -lt "$MIN_SESSION_LENGTH" ]; then
  echo "[ContinuousLearning] Session too short ($message_count messages), skipping" >&2
  exit 0
fi

# Signal to Gemini that session should be evaluated for extractable patterns
echo "[ContinuousLearning] Session has $message_count messages - evaluate for extractable patterns" >&2
echo "[ContinuousLearning] Save learned skills to: $LEARNED_SKILLS_PATH" >&2
