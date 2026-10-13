'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveMimoConfigDir } = require('./mimo-paths');
const { resolvePiAgentDir } = require('./pi-paths');
// A tool the person installed but never launched owns no config directory,
// so an existence check alone would skip it. The shell installers used to
// cover that with `command -v`; sharing the repo's own probe keeps the two
// detections from drifting, and it falls back to a PATH scan where `which`
// itself is missing.
const { commandExists } = require('./utils');
const { resolveCrushConfigPath } = require('./install-targets/crush-home');
const { resolveVibeHome } = require('./install-targets/vibe-home');
const { resolveGrokHome } = require('./install-targets/grok-home');
const { resolveKiloConfigDir } = require('./install-targets/kilo-home');
const { assertLandsInside, readFileIfExists, writeConfig } = require('./mcp-register-config-io');
const { parseJsonObject } = require('./mcp-register-json-writers');
const { resolveClaudeCli } = require('./mcp-register-claude-cli');

/**
 * Tool configs that get egc-guardian / egc-memory registered into them,
 * relative to a given home directory. Each target is only written to if
 * `gate()` returns true, so we don't create config files for tools the
 * person doesn't have installed.
 */
// OpenCode resolves its global config directory through xdg-basedir, which
// is XDG_CONFIG_HOME or ~/.config on every platform, Windows included (there
// is no %APPDATA% lookup in OpenCode). From that directory it loads, in
// order, config.json, opencode.json and opencode.jsonc, and it reads MCP
// servers from the `mcp` key. The documented file name is opencode.json;
// config.json is the legacy name it still honours (#1405).
function openCodeConfigDir(homeDir) {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'opencode');
}

function kiloConfigDir(homeDir) {
  return resolveKiloConfigDir(homeDir);
}

// The file the servers go into: the documented name when it exists, the
// legacy name when only that exists, the documented name when creating.
// A jsonc file is never edited (comments would not survive a rewrite);
// OpenCode merges every file it finds, so a sibling opencode.json is read.
function openCodeConfigPath(homeDir) {
  const dir = openCodeConfigDir(homeDir);
  const documented = path.join(dir, 'opencode.json');
  const legacy = path.join(dir, 'config.json');
  if (fs.existsSync(documented)) return documented;
  if (fs.existsSync(legacy)) return legacy;
  return documented;
}

function registerOpenCodeInstructions(targetPath, instructionFile, homeDir = process.env.HOME || process.env.USERPROFILE) {
  const allowedRoots = [homeDir, process.env.XDG_CONFIG_HOME].filter(Boolean);
  assertLandsInside(targetPath, allowedRoots);

  const obj = parseJsonObject(targetPath, readFileIfExists(targetPath), 'OpenCode config');
  if (obj.instructions === undefined || obj.instructions === null) {
    obj.instructions = [];
  } else if (!Array.isArray(obj.instructions)) {
    throw new TypeError(`existing file at ${targetPath} has an invalid instructions list - left untouched`);
  }
  if (obj.instructions.includes(instructionFile)) return false;
  obj.instructions.push(instructionFile);
  writeConfig(targetPath, JSON.stringify(obj, null, 2) + '\n');
  return true;
}

// Gemini CLI and Continue.dev left this list with their retirement (their
// adapters went in #1279); the ~/.gemini tree below belongs to Antigravity.
// The Antigravity CLI, the Antigravity IDE and Antigravity 2.0 all read the
// shared ~/.gemini/config/mcp_config.json (antigravity.google/docs/mcp); the
// CLI stopped opening antigravity-cli/mcp_config.json once it migrated its
// data (changelog 1.0.3 calls that path legacy). Each surface keeps its own
// data directory, so any of them, or the shared config itself, marks an
// Antigravity install.
const ANTIGRAVITY_SURFACES = ['config', 'antigravity', 'antigravity-cli', 'antigravity-ide'];

// Kimi Code CLI keeps its config under ~/.kimi-code by default; KIMI_CODE_HOME
// moves it, and a leading tilde there is expanded to the home directory so a
// value like ~/kimi-data is not read as relative to the process working
// directory. Mirrors scripts/lib/install-targets/kimi-home.js so the
// registration path and the install root stay in step.
function resolveKimiCodeHome(homeDir) {
  const configured = process.env.KIMI_CODE_HOME;
  if (configured) {
    if (configured === '~' || configured.startsWith('~/')) {
      return path.join(homeDir, configured.slice(1));
    }
    return path.resolve(configured);
  }
  return path.join(homeDir, '.kimi-code');
}

function buildMcpRegistrationTargets(homeDir) {
  return [
    {
      name: 'Antigravity',
      path: path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
      gate: () => ANTIGRAVITY_SURFACES.some(dir => fs.existsSync(path.join(homeDir, '.gemini', dir))),
      format: 'json',
    },
    {
      name: 'Antigravity CLI (pre-migration path)',
      path: path.join(homeDir, '.gemini', 'antigravity-cli', 'mcp_config.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.gemini', 'antigravity-cli')),
      format: 'json',
    },
    {
      // Registration goes through the Claude Code CLI itself (`claude mcp
      // add -s user`), which owns ~/.claude.json. The old target here wrote
      // ~/.claude/claude_desktop_config.json, a file Claude Code never
      // reads (that filename belongs to Claude Desktop, which keeps its
      // config elsewhere entirely), so init reported a registration that
      // did nothing. The path field is the effective destination the CLI
      // maintains, shown in dry-run output.
      name: 'Claude Code (user scope)',
      path: path.join(homeDir, '.claude.json'),
      gate: () => resolveClaudeCli() !== null,
      format: 'claude-cli',
    },
    {
      name: 'Cursor',
      path: path.join(homeDir, '.cursor', 'mcp.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.cursor')) || commandExists('cursor'),
      format: 'json',
    },
    {
      name: 'Kiro',
      path: path.join(homeDir, '.kiro', 'settings', 'mcp.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.kiro')) || commandExists('kiro'),
      format: 'json',
    },
    {
      name: 'Codex CLI',
      path: path.join(homeDir, '.codex', 'config.toml'),
      gate: () => fs.existsSync(path.join(homeDir, '.codex', 'config.toml')) || commandExists('codex'),
      format: 'toml',
      tomlTables: 'per-server',
    },
    {
      name: 'OpenCode',
      path: openCodeConfigPath(homeDir),
      // The directory is what OpenCode creates on first launch and what the
      // plugin and skills installers already write into; the PATH signal
      // covers an install that was never launched. Same rule on every
      // platform, since OpenCode's paths are the same everywhere.
      gate: () => fs.existsSync(openCodeConfigDir(homeDir)) || commandExists('opencode'),
      format: 'opencode-mcp',
    },
    {
      name: 'Zed',
      path: path.join(homeDir, '.config', 'zed', 'settings.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.config', 'zed')),
      format: 'zed-context-servers',
    },
    {
      // Auggie persists MCP servers in ~/.augment/settings.json, a general
      // settings file (also holds enableToolSearch and other keys), under
      // the standard mcpServers object `auggie mcp add` itself writes to
      // (docs.augmentcode.com/cli/integrations, 2026-10-09). The generic
      // 'json' format merges into mcpServers and leaves every other key
      // untouched, so it is safe on a file that is not MCP-only.
      name: 'Auggie',
      path: path.join(homeDir, '.augment', 'settings.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.augment')) || commandExists('auggie'),
      format: 'json',
    },
    {
      // Kimi Code CLI (MoonshotAI/kimi-code) reads MCP servers from
      // ~/.kimi-code/mcp.json (or $KIMI_CODE_HOME/mcp.json) in the standard
      // {mcpServers: {name: {command, args}}} JSON shape. The gate opens on the
      // config directory (created on first launch) or the `kimi` binary on
      // PATH, so a machine that installed the CLI but never launched it is
      // still covered.
      name: 'Kimi Code CLI',
      path: path.join(resolveKimiCodeHome(homeDir), 'mcp.json'),
      gate: () => fs.existsSync(resolveKimiCodeHome(homeDir)) || commandExists('kimi'),
      allowedRoot: resolveKimiCodeHome(homeDir),
      format: 'json',
    },
    {
      name: 'Crush',
      path: resolveCrushConfigPath(homeDir),
      gate: () => fs.existsSync(path.dirname(resolveCrushConfigPath(homeDir))) || commandExists('crush'),
      allowedRoot: process.env.CRUSH_GLOBAL_CONFIG ? path.dirname(resolveCrushConfigPath(homeDir)) : undefined,
      format: 'crush-mcp',
    },
    {
      // Mistral Vibe keeps its MCP servers as [[mcp_servers]] tables in
      // config.toml under VIBE_HOME or ~/.vibe (README of mistral-vibe,
      // 2026-10-10), each naming its transport; a stdio server names its
      // command and args. The gate opens on the data root (created on first
      // launch) or the `vibe` binary on PATH.
      name: 'Mistral Vibe',
      path: path.join(resolveVibeHome(homeDir), 'config.toml'),
      gate: () => fs.existsSync(resolveVibeHome(homeDir)) || commandExists('vibe'),
      allowedRoot: resolveVibeHome(homeDir),
      format: 'toml',
      tomlServerKeys: { transport: 'stdio' },
    },
    {
      name: 'Qwen Code',
      path: path.join(homeDir, '.qwen', 'settings.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.qwen')) || commandExists('qwen'),
      format: 'json',
    },
    {
      name: 'Grok Build',
      path: path.join(resolveGrokHome(homeDir), 'config.toml'),
      gate: () => fs.existsSync(resolveGrokHome(homeDir)) || commandExists('grok'),
      allowedRoot: resolveGrokHome(homeDir),
      format: 'toml',
      tomlTables: 'per-server',
    },
    {
      name: 'Kilo Code CLI',
      path: path.join(kiloConfigDir(homeDir), 'kilo.json'),
      gate: () => fs.existsSync(kiloConfigDir(homeDir)) || commandExists('kilo'),
      allowedRoot: kiloConfigDir(homeDir),
      format: 'opencode-mcp',
    },
    {
      name: 'MiMo Code',
      path: path.join(resolveMimoConfigDir(homeDir), 'mimocode.json'),
      gate: () => fs.existsSync(resolveMimoConfigDir(homeDir)) || commandExists('mimo'),
      allowedRoot: resolveMimoConfigDir(homeDir),
      format: 'opencode-mcp',
    },
    {
      name: 'Pi',
      path: path.join(resolvePiAgentDir(homeDir), 'mcp.json'),
      gate: () => fs.existsSync(resolvePiAgentDir(homeDir)) || commandExists('pi'),
      allowedRoot: resolvePiAgentDir(homeDir),
      format: 'json',
    },
    {
      name: 'Droid (Factory)',
      path: path.join(homeDir, '.factory', 'mcp.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.factory')) || commandExists('droid'),
      format: 'json',
    },
  ];
}

module.exports = {
  openCodeConfigDir,
  kiloConfigDir,
  openCodeConfigPath,
  registerOpenCodeInstructions,
  buildMcpRegistrationTargets,
};
