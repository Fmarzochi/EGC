#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# npm strips the root package-lock.json from the published tarball, and the
# guardian/memory lockfiles are not in package.json "files", so `npm ci` has no
# lockfile during a clean `npm install -g @egchq/egc` + `egc install`. Use npm ci
# only when a lockfile is present (git checkout) and fall back to npm install.
install_deps() {
  if [ -f package-lock.json ]; then
    npm ci --silent
  else
    # No lockfile: install without running untrusted lifecycle scripts, then
    # rebuild only the already-resolved native modules (e.g. better-sqlite3).
    npm install --ignore-scripts --no-audit --no-fund --silent
    npm rebuild --silent
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

# Node.js version check
NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js >= 18 is required (found: $(node --version 2>/dev/null || echo 'not found'))"
  exit 1
fi
echo "  node $(node --version)"

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm not found. Install Node.js >= 18 (https://nodejs.org)"
  exit 1
fi
echo "  npm $(npm --version)"

if ! command -v npx >/dev/null 2>&1; then
  echo "Error: npx not found. Install Node.js >= 18 (https://nodejs.org)"
  exit 1
fi

# Optional dependency hints (non-blocking)
if ! command -v uv >/dev/null 2>&1; then
  echo "  note: uv not found: jira and omega-memory MCP servers require it (https://docs.astral.sh/uv/)"
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "  note: python3 not found: evalview MCP server requires it"
fi

if [ "$DRY_RUN" = false ]; then
  # Root dependencies (better-sqlite3 etc.)
  echo "  installing root dependencies..."
  cd "$ROOT_DIR"
  install_deps

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
fi

# Delegate to Node installer only when install-relevant args are present
cd "$ROOT_DIR"
_has_install_args=false
for _arg in "$@"; do
  case "$_arg" in
    --target|--profile|--modules|--config|--with|--without|--dry-run|--json) _has_install_args=true; break ;;
  esac
  # positional arg = language/component
  case "$_arg" in -*) ;; *) _has_install_args=true; break ;; esac
done
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
      "args": ["$ROOT_DIR/mcp/servers/egc-guardian/build/index.js"]
    },
    "egc-memory": {
      "command": "node",
      "args": ["$ROOT_DIR/mcp/servers/egc-memory/build/index.js"]
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

# Final validation
node scripts/egc.js doctor

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

GUARDIAN_BIN="$ROOT_DIR/mcp/servers/egc-guardian/build/index.js"
MEMORY_BIN="$ROOT_DIR/mcp/servers/egc-memory/build/index.js"

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
    process.exit(0);
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
  if [ $rc -eq 0 ]; then
    echo "  ✓ registered in $label ($target)"
  fi
}

register_mcp_toml_codex() {
  local target="$1"
  node - "$target" "$GUARDIAN_BIN" "$MEMORY_BIN" <<'NODEEOF'
const fs   = require("fs");
const path = require("path");

const [,, target, guardianBin, memoryBin] = process.argv;

const guardianEntry =
  `\n[[mcp_servers]]\nname = "egc-guardian"\ncommand = "node"\nargs = ["${guardianBin}"]\n`;
const memoryEntry =
  `\n[[mcp_servers]]\nname = "egc-memory"\ncommand = "node"\nargs = ["${memoryBin}"]\n`;

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
if command -v claude >/dev/null 2>&1 || [ -d "$HOME/.claude" ]; then
  register_mcp_json "$HOME/.claude/claude_desktop_config.json" "Claude Code (global)"
  if [ -f "$ROOT_DIR/.mcp.json" ]; then
    register_mcp_json "$ROOT_DIR/.mcp.json" "Claude Code (project .mcp.json)"
  fi
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
  try { obj = JSON.parse(fs.readFileSync(target, "utf8")); } catch (_) { process.exit(0); }
}
if (!obj.mcpServers) obj.mcpServers = {};
if (obj.mcpServers.obsidian) process.exit(0);
obj.mcpServers.obsidian = obsidian;
const dir = path.dirname(target);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(target, JSON.stringify(obj, null, 2) + "\n");
NODEEOF
  local rc=$?
  if [ $rc -eq 0 ]; then
    echo "  ✓ obsidian synced to $label"
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

echo ""
echo "Installation complete."
echo "Run 'egc doctor' to verify."
