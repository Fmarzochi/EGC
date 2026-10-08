#!/usr/bin/env bash
# egc-paths.sh: where the skills of the tool in use live. Sourced by scan.sh
# and quick-diff.sh; nothing here runs on its own.
#
# The EGC directory is resolved the way scripts/lib/utils.js getEGCDir does:
# EGC_DIR, then the tool this script runs inside (its environment, then the
# folder the script was installed under), then the EGC folder of the home,
# then the first tool folder present in the home, then the EGC folder.

EGC_DEFAULT_DIR=.egc
EGC_KNOWN_TOOL_DIRS=(.codeium/windsurf .config/opencode .config/zed .gemini .claude .cursor .agents .amp .continue .github .kiro .trae .trae-cn .codebuddy)

# egc_dir [SCRIPT_DIR]: the EGC directory of the home.
egc_dir() {
  local script_dir="${1:-}" pair var dir
  if [[ -n "${EGC_DIR:-}" ]]; then echo "$EGC_DIR"; return; fi
  for pair in GEMINI_PROJECT_DIR=.gemini GEMINI_PLUGIN_ROOT=.gemini CLAUDECODE=.claude CLAUDE_PROJECT_DIR=.claude CLAUDE_PLUGIN_ROOT=.claude CODEBUDDY_PROJECT_DIR=.codebuddy CODEBUDDY_PLUGIN_ROOT=.codebuddy VSCODE_AGENT=.github GITHUB_COPILOT_API_TOKEN=.github KIRO_HOOK_FILE=.kiro KIRO_FILE_PATH=.kiro; do
    var="${pair%%=*}"
    if [[ -n "${!var:-}" ]]; then echo "$HOME/${pair#*=}"; return; fi
  done
  if [[ -n "${TRAE_ENV:-}" ]]; then
    if [[ "$TRAE_ENV" == "cn" ]]; then echo "$HOME/.trae-cn"; else echo "$HOME/.trae"; fi
    return
  fi
  for dir in "${EGC_KNOWN_TOOL_DIRS[@]}"; do
    case "$script_dir/" in "$HOME/$dir/"*) echo "$HOME/$dir"; return ;; esac
  done
  for dir in "$EGC_DEFAULT_DIR" "${EGC_KNOWN_TOOL_DIRS[@]}"; do
    if [[ -d "$HOME/$dir" ]]; then echo "$HOME/$dir"; return; fi
  done
  echo "$HOME/$EGC_DEFAULT_DIR"
}

# egc_global_skills_dir [SCRIPT_DIR]: the global skills folder, skills/ of the
# EGC directory, except in the Antigravity home, where every surface reads
# config/skills.
egc_global_skills_dir() {
  local dir
  dir="$(egc_dir "${1:-}")"
  if [[ "$dir" == "$HOME/.gemini" && -d "$dir/config/skills" ]]; then
    echo "$dir/config/skills"
  else
    echo "$dir/skills"
  fi
}

# egc_project_skills_dir PROJECT: the project skills folder, .agents/skills
# (the folder most tools read) or the first tool folder of the project that
# holds skills.
egc_project_skills_dir() {
  local project="$1" dir
  for dir in .agents .claude .gemini .cursor .github .kiro .trae .trae-cn .codebuddy .amp .continue; do
    if [[ -d "$project/$dir/skills" ]]; then echo "$project/$dir/skills"; return; fi
  done
  echo "$project/.agents/skills"
}
