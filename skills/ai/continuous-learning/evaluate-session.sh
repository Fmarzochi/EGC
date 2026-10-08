#!/bin/bash
# Continuous Learning - Session Evaluator
# Runs on Stop hook to extract reusable patterns from AI coding sessions
#
# Why Stop hook instead of UserPromptSubmit:
# - Stop runs once at session end (lightweight)
# - UserPromptSubmit runs every message (heavy, adds latency)
#
# Hook config, in the hook settings of your tool (example for Claude Code,
# ~/.claude/settings.json, with the path the skill was installed under):
# {
#   "hooks": {
#     "Stop": [{
#       "matcher": "*",
#       "hooks": [{
#         "type": "command",
#         "command": "~/.claude/skills/continuous-learning/evaluate-session.sh"
#       }]
#     }]
#   }
# }
#
# Patterns to detect: error_resolution, debugging_techniques, workarounds, project_specific
# Patterns to ignore: simple_typos, one_time_fixes, external_api_issues
# Extracted skills saved to skills/learned/ of the EGC directory in use, unless
# config.json pins learned_skills_path.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.json"
MIN_SESSION_LENGTH=10

# The EGC directory in use, resolved the way scripts/lib/utils.js getEGCDir
# does: EGC_DIR, then the tool this hook runs inside (its environment, then
# the folder the script was installed under), then the EGC folder of the
# home, then the first tool folder present in the home, then the EGC folder.
EGC_DEFAULT_DIR=.egc
EGC_KNOWN_TOOL_DIRS=(.codeium/windsurf .config/opencode .config/zed .gemini .claude .cursor .agents .amp .continue .github .kiro .trae .trae-cn .codebuddy)
egc_dir() {
  local pair var dir
  if [ -n "${EGC_DIR:-}" ]; then echo "$EGC_DIR"; return; fi
  for pair in GEMINI_PROJECT_DIR=.gemini GEMINI_PLUGIN_ROOT=.gemini CLAUDECODE=.claude CLAUDE_PROJECT_DIR=.claude CLAUDE_PLUGIN_ROOT=.claude CODEBUDDY_PROJECT_DIR=.codebuddy CODEBUDDY_PLUGIN_ROOT=.codebuddy VSCODE_AGENT=.github GITHUB_COPILOT_API_TOKEN=.github KIRO_HOOK_FILE=.kiro KIRO_FILE_PATH=.kiro; do
    var="${pair%%=*}"
    if [ -n "${!var:-}" ]; then echo "$HOME/${pair#*=}"; return; fi
  done
  if [ -n "${TRAE_ENV:-}" ]; then
    if [ "$TRAE_ENV" = "cn" ]; then echo "$HOME/.trae-cn"; else echo "$HOME/.trae"; fi
    return
  fi
  for dir in "${EGC_KNOWN_TOOL_DIRS[@]}"; do
    case "$SCRIPT_DIR/" in "$HOME/$dir/"*) echo "$HOME/$dir"; return ;; esac
  done
  for dir in "$EGC_DEFAULT_DIR" "${EGC_KNOWN_TOOL_DIRS[@]}"; do
    if [ -d "$HOME/$dir" ]; then echo "$HOME/$dir"; return; fi
  done
  echo "$HOME/$EGC_DEFAULT_DIR"
}

LEARNED_SKILLS_PATH="$(egc_dir)/skills/learned"

if [ -f "$CONFIG_FILE" ]; then
  if ! command -v jq &>/dev/null; then
    echo "[ContinuousLearning] jq is required to parse config.json but not installed, using defaults" >&2
  else
    MIN_SESSION_LENGTH=$(jq -r '.min_session_length // 10' "$CONFIG_FILE")
    configured_path=$(jq -r '.learned_skills_path // empty' "$CONFIG_FILE")
    if [ -n "$configured_path" ]; then
      LEARNED_SKILLS_PATH="${configured_path/#\~/$HOME}"
    fi
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
