#!/bin/bash
# The documented entrypoint is `sh scripts/install.sh`; on systems where sh is
# dash the script re-executes itself under bash, which everything below needs.
# Without bash on the machine it stops here with a plain message instead of
# failing later on the first bash-only construct.
case "${BASH_VERSION:-}" in
  '')
    if command -v bash >/dev/null 2>&1; then
      exec bash "$0" "$@"
    fi
    echo "Error: this installer requires bash; install bash or run it as 'bash scripts/install.sh'." >&2
    exit 1
    ;;
  *) ;;
esac
set -e

# Both of these resolve symlinks (pwd -P). Mixing logical and physical
# paths would break the comparison further down on macOS, where /tmp is a
# symlink to /private/tmp: a repo cloned under /tmp would look like an
# unrelated user project to the installer.
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
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
  if [[ ! -f package-lock.json ]]; then
    return 0
  fi
  if [[ -w . ]]; then
    # The pinned npm ci keeps its lifecycle scripts on purpose: sqlite3's
    # install script is what fetches its prebuilt binary. Under set -e a
    # failure ends the script, so the ERR trap names the directory first.
    trap 'echo "Error: npm ci failed in $(pwd). Re-run with network access, or fix the directory ownership and try again." >&2' ERR
    npm ci --silent
    trap - ERR
    return 0
  fi
  # A read-only directory is the root-owned global npm prefix: `sudo npm
  # install -g @egchq/egc`, then `egc install` as the regular user (the
  # documented Linux flow). npm ci cannot write node_modules here, and with
  # --silent its EACCES used to kill the whole install with a bare exit 243.
  # The published package root already carries every dependency the MCP
  # servers declare, one level up, so confirm that and carry on.
  if node "$ROOT_DIR/scripts/check-mcp-deps.js" "$(pwd)"; then
    echo "  dependencies provided by the package root ($(pwd) is read-only)"
    return 0
  fi
  echo "Error: $(pwd) is not writable and its dependencies are not available from the package root." >&2
  echo "Re-run 'npm install -g @egchq/egc' as the user that owns the npm prefix, or fix the prefix ownership (see docs/installation.md, Permissions)." >&2
  exit 1
}

# Forward --help directly to the Node installer
if [[ "$1" = "--help" || "$1" = "-h" ]]; then
  node "$ROOT_DIR/scripts/install-apply.js" "$@"
  exit $?
fi

echo "EGC install"

# Detect --dry-run flag
DRY_RUN=false
for _arg in "$@"; do
  [[ "$_arg" = "--dry-run" ]] && DRY_RUN=true && break
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

if [[ "$DRY_RUN" = false ]]; then
  # Root dependencies (sqlite3 etc.)
  echo "  installing root dependencies..."
  cd "$ROOT_DIR"
  install_deps
  # The native sqlite3 binary is a prebuilt download; when it cannot load
  # here, EGC runs on its portable engine, so say so once and carry on.
  if ! node "$ROOT_DIR/scripts/check-native-sqlite.js" 2>/dev/null; then
    echo "  note: native sqlite3 unavailable on this machine; EGC uses its portable engine (search falls back to substring matching)."
  fi

  # Point the "egc" command at this checkout, so the "egc doctor" the message
  # at the end of this script tells the user to run (and anything else they
  # type afterward) targets the code that was just installed rather than a
  # stale prior global install left on PATH from an earlier npm publish.
  # Skipped when this tree IS the global npm install (`egc install` right
  # after `npm install -g @egchq/egc`): the egc bin on PATH already points
  # here, so there is nothing stale to outrank, and with a root-owned global
  # prefix (distro Node) the link can only fail and print a note about a
  # checkout the person does not have (#1218 Linux report). Both sides
  # resolve symlinks (pwd -P, matching ROOT_DIR above), so an nvm/mise-style
  # symlinked prefix still compares equal. Best-effort: some environments
  # lack permission to the global npm prefix, and that must not abort the
  # rest of the install.
  GLOBAL_PKG_DIR="$(npm root -g 2>/dev/null || true)/@egchq/egc"
  if [[ -d "$GLOBAL_PKG_DIR" && "$(cd "$GLOBAL_PKG_DIR" && pwd -P)" == "$ROOT_DIR" ]]; then
    echo "  egc command already provided by the global npm install"
  else
    echo "  linking the egc command to this checkout..."
    npm link --silent 2>/dev/null || echo "  note: npm link failed (no permission to the global npm prefix?). Run 'npm link' manually, or use 'node scripts/egc.js <command>' from this checkout."
  fi

  # egc-guardian
  echo "  building egc-guardian..."
  GUARDIAN_DIR="$ROOT_DIR/mcp/servers/egc-guardian"
  if [[ ! -d "$GUARDIAN_DIR" ]]; then
    echo "Error: $GUARDIAN_DIR not found" >&2
    exit 1
  fi
  cd "$GUARDIAN_DIR"
  install_deps
  # The published package ships build/ but not src/, so only (re)build from a
  # git checkout where the TypeScript sources are present.
  if [[ -d src ]]; then
    npm run build
  fi

  # egc-memory
  echo "  building egc-memory..."
  MEMORY_DIR="$ROOT_DIR/mcp/servers/egc-memory"
  if [[ ! -d "$MEMORY_DIR" ]]; then
    echo "Error: $MEMORY_DIR not found" >&2
    exit 1
  fi
  cd "$MEMORY_DIR"
  install_deps
  # Published package ships build/ but not src/; only build from a checkout.
  if [[ -d src ]]; then
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
  if [[ "$_has_install_args" != true ]]; then
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
if [[ "$_has_install_args" = true ]]; then
  node scripts/install-apply.js "$@"
fi

[[ "$DRY_RUN" = true ]] && exit 0

# Write harness config template
# The harness config is a convenience copy inside the package directory;
# a read-only global prefix cannot take it and does not need it (egc init
# registers the servers from the install-state), so skip with a note.
if [[ -w "$ROOT_DIR" ]]; then
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
else
  echo "  note: $ROOT_DIR is read-only; skipping the .mcp.egc.json convenience copy"
fi

# Verify MCP server builds exist
if [[ ! -f "$ROOT_DIR/mcp/servers/egc-guardian/build/index.js" ]]; then
  echo "Error: egc-guardian build missing: run 'cd mcp/servers/egc-guardian && npm run build'" >&2
  exit 1
fi
echo "  ✓ egc-guardian build verified"

if [[ ! -f "$ROOT_DIR/mcp/servers/egc-memory/build/index.js" ]]; then
  echo "Error: egc-memory build missing: run 'cd mcp/servers/egc-memory && npm run build'" >&2
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
if [[ -t 0 && "$DRY_RUN" = false ]]; then
  printf "\n  Install prompt library? (61 agents, 232 skills, 77 commands) [Y/n] "
  read -r _install_ans
  _install_ans="${_install_ans:-Y}"
  if [[ "$_install_ans" = "Y" || "$_install_ans" = "y" ]]; then
    if [[ -d "$HOME/.gemini" ]] || command -v gemini >/dev/null 2>&1 || command -v agy >/dev/null 2>&1; then
      echo "  installing to Gemini / AGY..."
      node "$ROOT_DIR/scripts/install-apply.js" --target egc --profile full
    fi
    if [[ -d "$HOME/.codex" ]] || command -v codex >/dev/null 2>&1; then
      echo "  installing to Codex..."
      node "$ROOT_DIR/scripts/install-apply.js" --target codex --profile full
    fi
    if [[ -d "$HOME/.opencode" ]] || command -v opencode >/dev/null 2>&1; then
      echo "  installing to OpenCode..."
      node "$ROOT_DIR/scripts/install-apply.js" --target opencode --profile full
    fi
    if [[ -d "$HOME/.kiro" ]] || command -v kiro >/dev/null 2>&1; then
      echo "  installing to Kiro..."
      node "$ROOT_DIR/scripts/install-apply.js" --target kiro --profile full
      bash "$ROOT_DIR/.kiro/install.sh" ~
    fi
    if [[ -d "$HOME/.trae" || -d "$HOME/.trae-cn" ]] || command -v trae >/dev/null 2>&1; then
      echo "  installing to Trae..."
      bash "$ROOT_DIR/.trae/install.sh" ~
    fi
    if [[ -d "$HOME/.codebuddy" ]] || command -v codebuddy >/dev/null 2>&1; then
      echo "  installing to CodeBuddy..."
      bash "$ROOT_DIR/.codebuddy/install.sh" ~
    fi
  fi
elif [[ "$DRY_RUN" = false ]]; then
  # Mirrors install.ps1: a non-TTY stdin skips the prompt-library step.
  # Announce it instead of skipping silently.
  echo "  note: non-interactive session; skipping the prompt-library step. Run 'egc install --target <tool> --profile full' to add it."
fi

# ── MCP auto-registration ─────────────────────────────────────────────────────

GUARDIAN_BIN="$MCP_ROOT_DIR/mcp/servers/egc-guardian/build/index.js"
MEMORY_BIN="$MCP_ROOT_DIR/mcp/servers/egc-memory/build/index.js"

set +e
echo "  registering MCP servers..."

# One registration list for every entry point. This block used to be a
# hand-written copy of scripts/lib/mcp-register.js, and the copies had
# drifted: Continue.dev and Zed were never registered by the shell
# installers at all, so installing through the shell wired up fewer tools
# than `egc init` did on the same machine. The project .mcp.json is passed
# in because only the shell knows the directory the person invoked it from.
# Claude Code is part of that same list (registered through its own CLI, in
# user scope), so there is no separate call for it here any more. The
# subshell runs the CLI from the directory the person invoked the installer
# in, which is how a project .mcp.json there gets picked up: the script
# itself cd'd to the package root long ago.
(cd "$INVOKED_FROM_DIR" && node "$ROOT_DIR/scripts/lib/mcp-register-cli.js" "$GUARDIAN_BIN" "$MEMORY_BIN")

set -e

# Install git pre-commit hook (strips egc:state blocks before commits)
if [[ -d "$ROOT_DIR/.git" && "$DRY_RUN" = false ]]; then
  GIT_HOOK="$ROOT_DIR/.git/hooks/pre-commit"
  STRIP_SCRIPT="$ROOT_DIR/scripts/hooks/git-pre-commit.sh"
  if [[ ! -f "$GIT_HOOK" ]]; then
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
if [[ "$_has_install_args" = false ]]; then
  # The README promises a live dashboard right after installation. The
  # launch/skip decision lives in exactly one place, shouldAutoLaunch()
  # inside the wrapper, so the shell never second-guesses it; the wrapper
  # prints the headless message itself when it declines. (No --dry-run
  # branch here: a dry run exits long before this point.)
  node "$ROOT_DIR/scripts/lib/dashboard-launch-cli.js" "$ROOT_DIR" || true
fi
echo "Re-check anytime with 'egc doctor'."
