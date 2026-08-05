#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# The directory the person ran the installer FROM. Captured here, before the
# first cd (line ~94 already moves to the package root), because the project
# .mcp.json merge near the end must target their project, not the package.
INVOKED_FROM_DIR="$(pwd -P)"

# On Windows via Git Bash/MSYS, $ROOT_DIR is a POSIX-style mount path (e.g.
# /c/Users/x/EGC) that bash and node-run-from-bash understand, but any path
# written into an MCP client's config JSON is read by that client's own
# native Windows node.exe (Claude Desktop, Cursor, etc. are native Windows
# programs, not Git Bash processes) and cannot resolve the /c/... mount
# form. `pwd -W` is MSYS's coreutils extension that prints the Windows-
# native equivalent (C:/Users/x/EGC); use it only for paths destined for a
# written config, never for bash's own cd/test/node invocations below.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*)
    MCP_ROOT_DIR="$(cd "$ROOT_DIR" && pwd -W)"
    ;;
  *)
    MCP_ROOT_DIR="$ROOT_DIR"
    ;;
esac

# npm strips the root package-lock.json from published tarballs, so a globally
# installed package has no root lockfile (npm already resolved its deps during
# `npm install -g`). The sub-package lockfiles travel via package.json "files",
# so run a pinned `npm ci` wherever a lockfile is present and skip otherwise.
install_deps() {
  if [ -f package-lock.json ]; then
    npm ci --silent
  fi
}

# Forward --help directly to the Node installer
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  node "$ROOT_DIR/scripts/install-apply.js" "$@"
  exit $?
fi

echo "EGC install"

# Detect --dry-run flag
DRY_RUN=false
for _arg in "$@"; do
  [ "$_arg" = "--dry-run" ] && DRY_RUN=true && break
done

# Detect whether we'll delegate to the Node installer below (install-apply.js
# configures the commit-privacy filter itself, so this script must skip its
# own copy of that step when delegating -- otherwise it runs twice).
_has_install_args=false
for _arg in "$@"; do
  case "$_arg" in
    --target|--profile|--modules|--config|--with|--without|--dry-run|--json) _has_install_args=true; break ;;
    *) ;;
  esac
  # positional arg = language/component
  case "$_arg" in -*) ;; *) _has_install_args=true; break ;; esac
done

# Node.js version check. Keep this floor in lockstep with package.json "engines"
# and scripts/preinstall.js, which both require Node 20; a lower gate here would
# let 18/19 reach the better-sqlite3 build and the TypeScript build steps below.
NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Error: Node.js >= 20 is required (found: $(node --version 2>/dev/null || echo 'not found'))" >&2
  exit 1
fi
echo "  node $(node --version)"

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm not found. Install Node.js >= 20 (https://nodejs.org)" >&2
  exit 1
fi
echo "  npm $(npm --version)"

if ! command -v npx >/dev/null 2>&1; then
  echo "Error: npx not found. Install Node.js >= 20 (https://nodejs.org)" >&2
  exit 1
fi

# Optional dependency hints (non-blocking)
if ! command -v uv >/dev/null 2>&1; then
  echo "  Optional dependency not found: uv"
  echo "    Required only for Jira and omega-memory MCP servers."
  echo "    Core EGC installation is unaffected. Install: https://docs.astral.sh/uv/"
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "  note: python3 not found: evalview MCP server requires it"
fi

if [ "$DRY_RUN" = false ]; then
  # Root dependencies (better-sqlite3 etc.)
  echo "  installing root dependencies..."
  cd "$ROOT_DIR"
  install_deps

  # Point the "egc" command at this checkout, so the "egc doctor" the message
  # at the end of this script tells the user to run (and anything else they
  # type afterward) targets the code that was just installed rather than a
  # stale prior global install left on PATH from an earlier npm publish.
  # Best-effort: some environments lack permission to the global npm prefix,
  # and that must not abort the rest of the install.
  echo "  linking the egc command to this checkout..."
  npm link --silent 2>/dev/null || echo "  note: npm link failed (no permission to the global npm prefix?). Run 'npm link' manually, or use 'node scripts/egc.js <command>' from this checkout."

  # egc-guardian
  echo "  building egc-guardian..."
  GUARDIAN_DIR="$ROOT_DIR/mcp/servers/egc-guardian"
  if [ ! -d "$GUARDIAN_DIR" ]; then
    echo "Error: $GUARDIAN_DIR not found"
    exit 1
  fi
  cd "$GUARDIAN_DIR"
  install_deps
  # The published package ships build/ but not src/, so only (re)build from a
  # git checkout where the TypeScript sources are present.
  if [ -d src ]; then
    npm run build
  fi

  # egc-memory
  echo "  building egc-memory..."
  MEMORY_DIR="$ROOT_DIR/mcp/servers/egc-memory"
  if [ ! -d "$MEMORY_DIR" ]; then
    echo "Error: $MEMORY_DIR not found"
    exit 1
  fi
  cd "$MEMORY_DIR"
  install_deps
  # Published package ships build/ but not src/; only build from a checkout.
  if [ -d src ]; then
    npm run build
  fi

  # Initialize database and local directories
  echo "  initializing database..."
  cd "$ROOT_DIR"
  node scripts/bootstrap-state-db.js
  echo "  bootstrapping cognitive protocol..."
  node "$ROOT_DIR/scripts/bootstrap-cognitive.js"

  # README promises memory "never gets committed to git" unconditionally,
  # but only `egc init` configured the filter that keeps that promise --
  # this quick-start script (the README's own documented command) never
  # did (2026-08-01 audit finding). Best-effort: must not fail the install.
  # Skipped when delegating to install-apply.js below (--target/--profile/etc.
  # present): that path runs this same setup itself, so running it here too
  # would configure the filter twice (cubic review, PR #1122).
  if [ "$_has_install_args" != true ]; then
    node - "$ROOT_DIR" <<'NODEEOF' || echo "  note: commit-privacy filter setup failed (non-fatal)"
const [, , rootDir] = process.argv;
const { applyCommitPrivacyFilterCli } = require(rootDir + '/scripts/lib/memory-filters');
applyCommitPrivacyFilterCli({
  projectDir: process.cwd(),
  scriptPath: rootDir + '/scripts/check-state-leak.js',
  log: m => console.log('  ' + m),
});
NODEEOF
  fi
fi

# Delegate to Node installer only when install-relevant args are present
cd "$ROOT_DIR"
if [ "$_has_install_args" = true ]; then
  node scripts/install-apply.js "$@"
fi

[ "$DRY_RUN" = true ] && exit 0

# Write harness config template
cat > "$ROOT_DIR/.mcp.egc.json" <<EOF
{
  "mcpServers": {
    "egc-guardian": {
      "command": "node",
      "args": ["$MCP_ROOT_DIR/mcp/servers/egc-guardian/build/index.js"]
    },
    "egc-memory": {
      "command": "node",
      "args": ["$MCP_ROOT_DIR/mcp/servers/egc-memory/build/index.js"]
    }
  }
}
EOF
echo "  harness config written to .mcp.egc.json"

# Verify MCP server builds exist
if [ ! -f "$ROOT_DIR/mcp/servers/egc-guardian/build/index.js" ]; then
  echo "Error: egc-guardian build missing: run 'cd mcp/servers/egc-guardian && npm run build'"
  exit 1
fi
echo "  ✓ egc-guardian build verified"

if [ ! -f "$ROOT_DIR/mcp/servers/egc-memory/build/index.js" ]; then
  echo "Error: egc-memory build missing: run 'cd mcp/servers/egc-memory && npm run build'"
  exit 1
fi
echo "  ✓ egc-memory build verified"

# Final validation. `egc doctor` exits 1 on warnings, not just errors (by
# design, for standalone/CI use) -- under this script's `set -e`, an
# untreated non-zero exit here would silently abort the rest of the install
# (MCP registration, ecosystem install, the Token Crusher shim below) on any
# warning, however minor. This is a status report, not a gate: never let it
# be fatal to the install.
node scripts/egc.js doctor --repo-root "$ROOT_DIR" || true

# Interactive ecosystem install (skipped in CI/headless environments)
if [ -t 0 ] && [ "$DRY_RUN" = false ]; then
  printf "\n  Install prompt library? (62 agents, 228 skills, 74 commands) [Y/n] "
  read -r _install_ans
  _install_ans="${_install_ans:-Y}"
  if [ "$_install_ans" = "Y" ] || [ "$_install_ans" = "y" ]; then
    if [ -d "$HOME/.gemini" ] || command -v gemini >/dev/null 2>&1 || command -v agy >/dev/null 2>&1; then
      echo "  installing to Gemini / AGY..."
      node "$ROOT_DIR/scripts/install-apply.js" --target egc --profile full
    fi
    if [ -d "$HOME/.codex" ] || command -v codex >/dev/null 2>&1; then
      echo "  installing to Codex..."
      node "$ROOT_DIR/scripts/install-apply.js" --target codex --profile full
    fi
    if [ -d "$HOME/.opencode" ] || command -v opencode >/dev/null 2>&1; then
      echo "  installing to OpenCode..."
      node "$ROOT_DIR/scripts/install-apply.js" --target opencode --profile full
    fi
    if [ -d "$HOME/.kiro" ] || command -v kiro >/dev/null 2>&1; then
      echo "  installing to Kiro..."
      node "$ROOT_DIR/scripts/install-apply.js" --target kiro --profile full
      bash "$ROOT_DIR/.kiro/install.sh" ~
    fi
    if [ -d "$HOME/.trae" ] || [ -d "$HOME/.trae-cn" ] || command -v trae >/dev/null 2>&1; then
      echo "  installing to Trae..."
      bash "$ROOT_DIR/.trae/install.sh" ~
    fi
    if [ -d "$HOME/.codebuddy" ] || command -v codebuddy >/dev/null 2>&1; then
      echo "  installing to CodeBuddy..."
      bash "$ROOT_DIR/.codebuddy/install.sh" ~
    fi
  fi
fi

# ── MCP auto-registration ─────────────────────────────────────────────────────

GUARDIAN_BIN="$MCP_ROOT_DIR/mcp/servers/egc-guardian/build/index.js"
MEMORY_BIN="$MCP_ROOT_DIR/mcp/servers/egc-memory/build/index.js"

register_mcp_json() {
  local target="$1"
  local label="$2"
  node - "$target" "$GUARDIAN_BIN" "$MEMORY_BIN" <<'NODEEOF'
const fs   = require("fs");
const path = require("path");

const [,, target, guardianBin, memoryBin] = process.argv;

let obj = { mcpServers: {} };
if (fs.existsSync(target)) {
  try {
    obj = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (_) {
    // Existing config is not valid JSON: leave it untouched and signal a skip
    // (exit 2) so the caller does not print a false "registered" success.
    process.exit(2);
  }
}
if (!obj.mcpServers) obj.mcpServers = {};

let changed = false;
if (!obj.mcpServers["egc-guardian"]) {
  obj.mcpServers["egc-guardian"] = { command: "node", args: [guardianBin] };
  changed = true;
}
if (!obj.mcpServers["egc-memory"]) {
  obj.mcpServers["egc-memory"] = { command: "node", args: [memoryBin] };
  changed = true;
}
if (!changed) process.exit(0);

const dir = path.dirname(target);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(target, JSON.stringify(obj, null, 2) + "\n");
NODEEOF
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "  ✓ registered in $label ($target)"
  elif [[ $rc -eq 2 ]]; then
    echo "  note: skipped $label ($target): existing config is not valid JSON"
  fi
}

# Claude Code's user-scope MCP list lives in ~/.claude.json, owned by the
# CLI itself; `claude mcp add -s user` is the stable interface (the same
# approach scripts/lib/mcp-register.js uses for `egc init`). `claude mcp
# get` exiting 0 means the server is already registered.
register_mcp_claude_cli() {
  local name bin
  for name in egc-guardian egc-memory; do
    bin="$GUARDIAN_BIN"
    if [ "$name" = "egc-memory" ]; then bin="$MEMORY_BIN"; fi
    if claude mcp get "$name" >/dev/null 2>&1; then
      continue
    fi
    if claude mcp add -s user "$name" -- node "$bin" >/dev/null 2>&1; then
      echo "  ✓ registered $name in Claude Code (user scope)"
    else
      echo "  note: could not register $name in Claude Code. Run manually: claude mcp add -s user $name -- node \"$bin\""
    fi
  done
}

register_mcp_toml_codex() {
  local target="$1"
  node - "$target" "$GUARDIAN_BIN" "$MEMORY_BIN" <<'NODEEOF'
const fs   = require("fs");
const path = require("path");

const [,, target, guardianBin, memoryBin] = process.argv;

// Escape backslashes (Windows paths) and double quotes (legal in a POSIX dir
// name) so the path stays a valid TOML basic string; mirrors tomlEscape in
// scripts/lib/mcp-register.js.
const tomlEscape = (p) => p.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

const guardianEntry =
  `\n[[mcp_servers]]\nname = "egc-guardian"\ncommand = "node"\nargs = ["${tomlEscape(guardianBin)}"]\n`;
const memoryEntry =
  `\n[[mcp_servers]]\nname = "egc-memory"\ncommand = "node"\nargs = ["${tomlEscape(memoryBin)}"]\n`;

let content = "";
if (fs.existsSync(target)) {
  content = fs.readFileSync(target, "utf8");
}

let appended = false;
if (!content.includes('"egc-guardian"') && !content.includes("'egc-guardian'")) {
  content += guardianEntry;
  appended = true;
}
if (!content.includes('"egc-memory"') && !content.includes("'egc-memory'")) {
  content += memoryEntry;
  appended = true;
}
if (!appended) process.exit(0);

const dir = path.dirname(target);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(target, content);
NODEEOF
  local rc=$?
  if [ $rc -eq 0 ]; then
    echo "  ✓ registered in Codex CLI ($target)"
  fi
}

set +e
echo "  registering MCP servers..."

# AGY (Antigravity CLI)
if [ -d "$HOME/.gemini/antigravity-cli" ]; then
  register_mcp_json "$HOME/.gemini/antigravity-cli/mcp_config.json" "Antigravity CLI"
fi

# Gemini CLI (only when AGY is absent to avoid duplication)
if [ -d "$HOME/.gemini/config" ] && ! [ -d "$HOME/.gemini/antigravity-cli" ]; then
  register_mcp_json "$HOME/.gemini/config/mcp_config.json" "Gemini CLI"
fi

# Claude Code: global config
# Claude Code: registration goes through the CLI's own user scope. The old
# path here wrote ~/.claude/claude_desktop_config.json, a file Claude Code
# never reads (that filename belongs to Claude Desktop, which keeps its
# config elsewhere entirely), so install reported a registration that did
# nothing. No CLI on PATH means no Claude Code to register into.
if command -v claude >/dev/null 2>&1; then
  register_mcp_claude_cli
fi
# Merge into an existing project .mcp.json in the directory the installer
# was invoked from only: the package's own bundled .mcp.json is not a user
# project, and creating a file in an arbitrary cwd would litter. ($PWD is
# useless here - the script cd'd to the package root long ago.)
if [ -f "$INVOKED_FROM_DIR/.mcp.json" ] && [ "$INVOKED_FROM_DIR" != "$ROOT_DIR" ]; then
  register_mcp_json "$INVOKED_FROM_DIR/.mcp.json" "Claude Code (project .mcp.json)"
fi

# Cursor
if command -v cursor >/dev/null 2>&1 || [ -d "$HOME/.cursor" ]; then
  register_mcp_json "$HOME/.cursor/mcp.json" "Cursor"
fi

# Kiro
if command -v kiro >/dev/null 2>&1 || [ -d "$HOME/.kiro" ]; then
  register_mcp_json "$HOME/.kiro/settings/mcp.json" "Kiro"
fi

# Codex CLI
if command -v codex >/dev/null 2>&1 || [ -f "$HOME/.codex/config.toml" ]; then
  register_mcp_toml_codex "$HOME/.codex/config.toml"
fi

# OpenCode
if command -v opencode >/dev/null 2>&1 || [ -f "$HOME/.config/opencode/config.json" ]; then
  register_mcp_json "$HOME/.config/opencode/config.json" "OpenCode"
fi

set -e

# ── Obsidian MCP propagation ──────────────────────────────────────────────────

find_obsidian_config() {
  local sources=(
    "$HOME/.gemini/antigravity-cli/mcp_config.json"
    "$HOME/.gemini/config/mcp_config.json"
    "$HOME/.claude/claude_desktop_config.json"
    "$HOME/.cursor/mcp.json"
  )
  for src in "${sources[@]}"; do
    if [ -f "$src" ]; then
      local block
      block=$(node - "$src" <<'NODEEOF'
const fs = require("fs");
const [,, src] = process.argv;
try {
  const obj = JSON.parse(fs.readFileSync(src, "utf8"));
  if (obj.mcpServers && obj.mcpServers.obsidian) {
    process.stdout.write(JSON.stringify(obj.mcpServers.obsidian));
  }
} catch (_) {}
NODEEOF
)
      if [ -n "$block" ]; then
        printf '%s' "$block"
        return 0
      fi
    fi
  done
  return 1
}

propagate_obsidian_json() {
  local target="$1"
  local label="$2"
  local obsidian_block="$3"
  node - "$target" "$obsidian_block" <<'NODEEOF'
const fs   = require("fs");
const path = require("path");
const [,, target, obsidianBlock] = process.argv;
let obsidian;
try { obsidian = JSON.parse(obsidianBlock); } catch (_) { process.exit(0); }
let obj = { mcpServers: {} };
if (fs.existsSync(target)) {
  // Unparseable target config: skip (exit 2), do not report a false success.
  try { obj = JSON.parse(fs.readFileSync(target, "utf8")); } catch (_) { process.exit(2); }
}
if (!obj.mcpServers) obj.mcpServers = {};
if (obj.mcpServers.obsidian) process.exit(0);
obj.mcpServers.obsidian = obsidian;
const dir = path.dirname(target);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(target, JSON.stringify(obj, null, 2) + "\n");
NODEEOF
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "  ✓ obsidian synced to $label"
  elif [[ $rc -eq 2 ]]; then
    echo "  note: skipped obsidian sync to $label ($target): existing config is not valid JSON"
  fi
}

set +e
obsidian_block=$(find_obsidian_config)
if [ -n "$obsidian_block" ]; then
  if [ -d "$HOME/.gemini/antigravity-cli" ]; then
    propagate_obsidian_json "$HOME/.gemini/antigravity-cli/mcp_config.json" "Antigravity CLI" "$obsidian_block"
  fi
  if [ -d "$HOME/.gemini/config" ] && ! [ -d "$HOME/.gemini/antigravity-cli" ]; then
    propagate_obsidian_json "$HOME/.gemini/config/mcp_config.json" "Gemini CLI" "$obsidian_block"
  fi
  if command -v claude >/dev/null 2>&1 || [ -d "$HOME/.claude" ]; then
    propagate_obsidian_json "$HOME/.claude/claude_desktop_config.json" "Claude Code (global)" "$obsidian_block"
  fi
  if command -v cursor >/dev/null 2>&1 || [ -d "$HOME/.cursor" ]; then
    propagate_obsidian_json "$HOME/.cursor/mcp.json" "Cursor" "$obsidian_block"
  fi
  if command -v kiro >/dev/null 2>&1 || [ -d "$HOME/.kiro" ]; then
    propagate_obsidian_json "$HOME/.kiro/settings/mcp.json" "Kiro" "$obsidian_block"
  fi
  if command -v opencode >/dev/null 2>&1 || [ -f "$HOME/.config/opencode/config.json" ]; then
    propagate_obsidian_json "$HOME/.config/opencode/config.json" "OpenCode" "$obsidian_block"
  fi
fi
set -e

# Install git pre-commit hook (strips egc:state blocks before commits)
if [ -d "$ROOT_DIR/.git" ] && [ "$DRY_RUN" = false ]; then
  GIT_HOOK="$ROOT_DIR/.git/hooks/pre-commit"
  STRIP_SCRIPT="$ROOT_DIR/scripts/hooks/git-pre-commit.sh"
  if [ ! -f "$GIT_HOOK" ]; then
    printf '#!/usr/bin/env bash\nROOT="$(git rev-parse --show-toplevel)"\nbash "$ROOT/scripts/hooks/git-pre-commit.sh"\n' > "$GIT_HOOK"
    chmod +x "$GIT_HOOK"
    echo "  ✓ git pre-commit hook installed"
  elif ! grep -q "git-pre-commit.sh" "$GIT_HOOK" 2>/dev/null; then
    printf '\nROOT="$(git rev-parse --show-toplevel)"\nbash "$ROOT/scripts/hooks/git-pre-commit.sh"\n' >> "$GIT_HOOK"
    chmod +x "$GIT_HOOK"
    echo "  ✓ git pre-commit hook updated"
  else
    echo "  ✓ git pre-commit hook already installed"
  fi
fi

# Token Crusher PATH-level binary shim (git, npm, gh, ...). Best-effort: a
# failure here (permission, unsupported shell config, ...) must never abort
# an otherwise successful install. Skipped in --dry-run, same as the rest of
# this section.
if [[ "$DRY_RUN" = false ]]; then
  echo ""
  echo "Installing Token Crusher binary shim..."
  node "$ROOT_DIR/scripts/crusher-shim.js" install || echo "  note: crusher-shim install failed (non-fatal). Run 'node scripts/crusher-shim.js install' manually to retry."
fi

echo ""
echo "Installation complete."
if [ "$_has_install_args" = false ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "Dashboard launch skipped (--dry-run)."
  elif [ -t 1 ] && [ -z "${CI:-}" ]; then
    # The README promises a live dashboard right after installation; the
    # shared launcher keeps that true for a person at a terminal. The
    # gate is duplicated here (TTY + not CI, same rule as
    # shouldAutoLaunch) so headless installs never even need node for
    # this step.
    node "$ROOT_DIR/scripts/lib/dashboard-launch-cli.js" "$ROOT_DIR" || true
  else
    echo "Dashboard not started (headless environment). Run 'egc dashboard' to start it."
  fi
fi
echo "Run 'egc doctor' to verify."
