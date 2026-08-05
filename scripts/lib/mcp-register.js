'use strict';

/**
 * MCP server registration for `egc init`.
 *
 * Extracted from scripts/init.js so the registration logic (which tool
 * configs get egc-guardian / egc-memory written into) can be unit tested
 * without running the full init CLI, which executes top-to-bottom on
 * require() and has no exports of its own.
 *
 * scripts/init.js remains the only caller in production; it supplies the
 * real HOME dir, real bin paths, and wires the callbacks to its own
 * colorized console output. Tests supply a temp dir and inert bin paths
 * instead.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let TOML = null;
try {
  TOML = require('@iarna/toml');
} catch {
  // Handled per-call below: falls back to the substring check.
}

// A single read instead of existsSync() + readFileSync() closes the window
// where a concurrent process (an IDE, a cloud sync client) deletes or
// recreates the file between the two calls — existsSync() can say true and
// readFileSync() still throw ENOENT a moment later. Any other read error
// (permissions, a directory at that path) still propagates; only "genuinely
// absent" is treated as the same "start fresh" case as "never existed".
function readFileIfExists(targetPath) {
  try {
    return fs.readFileSync(targetPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Whether an active (uncommented, correctly-tabled) mcp_servers entry with
// the given name already exists. A plain string search matches commented-out
// lines too (`# name = "egc-guardian"` still contains the substring), which
// would make registerToml believe the server is registered when the user
// disabled it, and skip restoring it on the next `egc init`. Parsing catches
// that; if the file doesn't parse (mid-edit, genuinely malformed), fall back
// to the substring check rather than block registration entirely.
function tomlHasActiveServer(content, serverName) {
  if (TOML) {
    try {
      const parsed = TOML.parse(content);
      const servers = Array.isArray(parsed.mcp_servers) ? parsed.mcp_servers : [];
      return servers.some(server => server && server.name === serverName);
    } catch {
      // Fall through to the substring check below.
    }
  }
  return content.includes(`"${serverName}"`) || content.includes(`'${serverName}'`);
}

/**
 * Tool configs that get egc-guardian / egc-memory registered into them,
 * relative to a given home directory. Each target is only written to if
 * `gate()` returns true, so we don't create config files for tools the
 * person doesn't have installed.
 */
function buildMcpRegistrationTargets(homeDir) {
  return [
    {
      name: 'Antigravity CLI',
      path: path.join(homeDir, '.gemini', 'antigravity-cli', 'mcp_config.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.gemini', 'antigravity-cli')),
      format: 'json',
    },
    {
      name: 'Gemini CLI',
      path: path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.gemini', 'config')),
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
      gate: () => fs.existsSync(path.join(homeDir, '.cursor')),
      format: 'json',
    },
    {
      name: 'Continue.dev',
      // Continue's config.json is deprecated in favor of config.yaml, and
      // editing either directly risks clobbering unrelated model/prompt
      // config, so this doesn't touch either. It also doesn't use the
      // plain-JSON drop-in some docs mention for .continue/mcpServers/,
      // because that claim isn't scoped to global vs. workspace anywhere
      // official. What *is* confirmed at the source level: loadYaml.ts
      // calls getAllDotContinueDefinitionFiles(ide, { includeGlobal: true,
      // includeWorkspace: true, fileExtType: "yaml" }, blockType) for every
      // block type, and mcpServers is confirmed (via the published
      // @continuedev/config-yaml package's BLOCK_TYPES export) to be one of
      // them. So this writes standalone YAML block files instead - same
      // drop-in folder, format Continue's own loader is confirmed to scan
      // globally. path is the directory itself: registerContinueYaml
      // writes two files into it (one server per file - a single block's
      // mcpServers array is capped at one entry by Continue's own schema).
      // See https://docs.continue.dev/customize/deep-dives/mcp
      path: path.join(homeDir, '.continue', 'mcpServers'),
      gate: () => fs.existsSync(path.join(homeDir, '.continue')),
      format: 'continue-yaml',
    },
    {
      name: 'Kiro',
      path: path.join(homeDir, '.kiro', 'settings', 'mcp.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.kiro')),
      format: 'json',
    },
    {
      name: 'Codex CLI',
      path: path.join(homeDir, '.codex', 'config.toml'),
      gate: () => fs.existsSync(path.join(homeDir, '.codex', 'config.toml')),
      format: 'toml',
    },
    {
      name: 'OpenCode',
      path: path.join(homeDir, '.config', 'opencode', 'config.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.config', 'opencode', 'config.json')),
      format: 'json',
    },
    {
      name: 'Zed',
      path: path.join(homeDir, '.config', 'zed', 'settings.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.config', 'zed')),
      format: 'zed-context-servers',
    },
  ];
}

/**
 * Merges egc-guardian / egc-memory into a JSON mcpServers config, preserving
 * whatever else is already in the file. Returns true if the file was
 * created/changed, false if both entries were already present (a legitimate,
 * silent no-op). Throws if the existing file can't be parsed as JSON -
 * that's not a no-op, it's a reason the config wasn't touched, and the two
 * need to stay distinguishable so a caller can warn on one and stay quiet
 * on the other.
 */
function registerJson(targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  let obj = { mcpServers: {} };
  const existingContent = readFileIfExists(targetPath);
  if (existingContent !== null) {
    try {
      obj = JSON.parse(existingContent);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`existing file at ${targetPath} is not valid JSON - left untouched: ${err.message}`, { cause: err });
      }
      throw err;
    }
  }
  if (!obj.mcpServers) obj.mcpServers = {};
  let changed = false;
  if (!obj.mcpServers['egc-guardian']) {
    obj.mcpServers['egc-guardian'] = { command: 'node', args: [guardianBin] };
    changed = true;
  }
  if (!obj.mcpServers['egc-memory']) {
    obj.mcpServers['egc-memory'] = { command: 'node', args: [memoryBin] };
    changed = true;
  }
  if (!changed) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(obj, null, 2) + '\n');
  return true;
}

/**
 * Escapes a path for use inside a TOML basic (double-quoted) string.
 * Two characters can occur in a real filesystem path and break the string: a
 * backslash (TOML reserves "\U" for an 8-hex-digit Unicode escape, so a raw
 * Windows path like C:\Users\... silently corrupts the file the moment a
 * backslash precedes a hex-ish character) and a double quote (legal in a POSIX
 * directory name, and it would terminate the string early). Escape the
 * backslash first so the one added for the quote is not doubled again.
 */
function tomlEscape(p) {
  return p.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`);
}

/**
 * Same idea as registerJson but for TOML configs (Codex CLI). Returns true
 * if the file was appended to, false if both entries were already present.
 */
function registerToml(targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  let content = readFileIfExists(targetPath) ?? '';
  let appended = false;
  if (!tomlHasActiveServer(content, 'egc-guardian')) {
    content += `\n[[mcp_servers]]\nname = "egc-guardian"\ncommand = "node"\nargs = ["${tomlEscape(guardianBin)}"]\n`;
    appended = true;
  }
  if (!tomlHasActiveServer(content, 'egc-memory')) {
    content += `\n[[mcp_servers]]\nname = "egc-memory"\ncommand = "node"\nargs = ["${tomlEscape(memoryBin)}"]\n`;
    appended = true;
  }
  if (!appended) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content);
  return true;
}

/**
 * Writes standalone Continue.dev YAML block files (the format documented
 * at https://docs.continue.dev/customize/deep-dives/mcp, with required
 * name/version/schema metadata) registering egc-guardian and egc-memory.
 *
 * IMPORTANT: Continue's real schema (verified against the published
 * @continuedev/config-yaml package's parseBlock/blockSchema, not just
 * eyeballed) rejects a single block file whose mcpServers array has more
 * than one entry - "Array must contain exactly 1 element(s)". So this
 * writes two files, one server each, rather than one file with both.
 *
 * targetDir is the .continue/mcpServers/ folder itself, not a single file.
 * Unlike registerJson/registerToml this doesn't merge into files that
 * might hold unrelated user content - these are dedicated, EGC-owned
 * filenames, so each is just regenerated wholesale. Returns true if either
 * file was created or changed, false if both already matched exactly
 * (idempotent no-op).
 */
function registerContinueYaml(targetDir, bins) {
  const { guardianBin, memoryBin } = bins;
  const files = {
    'egc-guardian.yaml': [
      'name: EGC Guardian',
      'version: 0.0.1',
      'schema: v1',
      'mcpServers:',
      '  - name: egc-guardian',
      '    command: node',
      '    args:',
      // JSON.stringify produces a double-quoted scalar with the backslash/
      // quote escaping YAML expects. Needed because a bare scalar breaks on
      // paths containing "#" (starts a comment) or ": " (a mapping
      // separator) - both legal in a directory name.
      `      - ${JSON.stringify(guardianBin)}`,
      '',
    ].join('\n'),
    'egc-memory.yaml': [
      'name: EGC Memory',
      'version: 0.0.1',
      'schema: v1',
      'mcpServers:',
      '  - name: egc-memory',
      '    command: node',
      '    args:',
      `      - ${JSON.stringify(memoryBin)}`,
      '',
    ].join('\n'),
  };

  let changed = false;
  for (const [filename, desired] of Object.entries(files)) {
    const targetPath = path.join(targetDir, filename);
    if (fs.existsSync(targetPath)) {
      const existing = fs.readFileSync(targetPath, 'utf8');
      if (existing === desired) continue;
    }
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetPath, desired);
    changed = true;
  }
  return changed;
}

/**
 * Merges egc-guardian / egc-memory into Zed's settings.json under the
 * context_servers key. Reads mcp-configs/zed-context-servers.json as a
 * template, substitutes __GUARDIAN_BIN__ and __MEMORY_BIN__ with the
 * resolved paths, then merges the result into the existing settings file
 * without overwriting unrelated keys. Returns true if changed.
 */
function registerZedContextServers(targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  const templatePath = path.join(__dirname, '..', '..', 'mcp-configs', 'zed-context-servers.json');
  // The placeholders sit inside JSON string literals, so a Windows bin path's
  // backslashes (C:\Users\...) must be escaped before substitution or the
  // JSON.parse below throws on the invalid "\U" escape. jsonStringBody yields
  // the escaped body of a JSON string without its surrounding quotes.
  const jsonStringBody = (p) => JSON.stringify(p).slice(1, -1);
  const template = fs.readFileSync(templatePath, 'utf8')
    .replaceAll('__GUARDIAN_BIN__', jsonStringBody(guardianBin))
    .replaceAll('__MEMORY_BIN__', jsonStringBody(memoryBin));
  const incoming = JSON.parse(template);

  let settings = {};
  if (fs.existsSync(targetPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`existing file at ${targetPath} is not valid JSON - left untouched: ${err.message}`, { cause: err });
      }
      throw err;
    }
  }

  if (!settings.context_servers) settings.context_servers = {};
  let changed = false;
  for (const [key, value] of Object.entries(incoming.context_servers)) {
    if (!settings.context_servers[key]) {
      settings.context_servers[key] = value;
      changed = true;
    }
  }
  if (!changed) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

// Claude Code's user-scope MCP list lives inside ~/.claude.json, a large
// live state file the CLI rewrites while running - merging into it directly
// risks clobbering whatever the app writes next. The CLI's own `mcp` verbs
// are the stable interface, so registration is only attempted when the CLI
// is actually on PATH (that is also the honest gate: no CLI, no Claude Code
// to register into). PATH resolution is the point, not an accident: this
// must find whatever `claude` the user really runs. On Windows npm installs
// the CLI as claude.cmd, which spawnSync cannot launch without a shell, so
// the resolved candidate is filtered to spawnable extensions and later
// launched with the same shell rule the crusher shim uses.
function resolveClaudeCli() {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' }); // NOSONAR javascript:S4036 -- resolving the user's claude CLI from PATH is the feature; fixed argv, no shell
  if (probe.status !== 0 || !probe.stdout) return null;
  const candidates = probe.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return candidates.find(c => process.platform !== 'win32' || /\.(exe|com|cmd|bat)$/i.test(c)) || null;
}

/**
 * Registers egc-guardian / egc-memory in Claude Code's user scope via
 * `claude mcp add -s user`. `claude mcp get <name>` exiting 0 means the
 * server is already registered (idempotent no-op for that entry). Returns
 * true if any server was newly added, false if both were already present.
 * Throws when the CLI cannot run or refuses an add, so registerTarget
 * surfaces it as a warning instead of a false success.
 */
// When spawnSync runs through the Windows shell, the args array is joined
// onto the command line verbatim (windowsVerbatimArguments): no quoting at
// all, so an install path with a space (C:\Users\First Last\..., Program
// Files) splits into two arguments and the add silently registers garbage.
// Quote anything cmd.exe would misparse, doubling embedded quotes, the cmd
// convention. POSIX callers never hit this path (shell stays false there).
function quoteForCmdShell(arg) {
  if (!/[\s"^&|<>()%!]/.test(arg)) return arg;
  return '"' + arg.replaceAll('"', '""') + '"';
}

function registerClaudeCli(_targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  const cli = resolveClaudeCli();
  if (!cli) throw new Error('claude CLI not found on PATH');
  // Same Windows rule as the crusher shim: .cmd/.bat need a shell.
  const { needsShellOnWindows } = require('./crusher/shim-dispatch');
  const useShell = needsShellOnWindows(cli);
  const runCli = (args) => spawnSync(
    useShell ? quoteForCmdShell(cli) : cli,
    useShell ? args.map(quoteForCmdShell) : args,
    { encoding: 'utf8', shell: useShell }
  ); // NOSONAR javascript:S4036 -- cli was resolved above from the user's own PATH on purpose; fixed argv

  const servers = [
    ['egc-guardian', guardianBin],
    ['egc-memory', memoryBin],
  ];
  let changed = false;
  for (const [name, bin] of servers) {
    const existing = runCli(['mcp', 'get', name]);
    // A CLI that cannot even run is not "server missing" - surface it
    // instead of piling a doomed `add` on top.
    if (existing.error) throw existing.error;
    if (existing.status === 0) continue;
    const added = runCli(['mcp', 'add', '-s', 'user', name, '--', 'node', bin]);
    if (added.error) throw added.error;
    if (added.status !== 0) {
      throw new Error(`claude mcp add ${name} failed: ${(added.stderr || added.stdout || '').trim()}`);
    }
    changed = true;
  }
  return changed;
}

const FORMAT_HANDLERS = {
  'json': registerJson,
  'toml': registerToml,
  'continue-yaml': registerContinueYaml,
  'zed-context-servers': registerZedContextServers,
  'claude-cli': registerClaudeCli,
};

function registerTarget(target, bins, onRegister, onWarn) {
  const handler = FORMAT_HANDLERS[target.format];
  if (!handler) return;
  try {
    const registered = handler(target.path, bins);
    if (registered && onRegister) onRegister(target);
  } catch (err) {
    if (onWarn) onWarn(target, err);
  }
}

/**
 * Walks every gated target for homeDir and registers egc-guardian /
 * egc-memory into whichever tools are actually installed. Callbacks let the
 * caller (scripts/init.js) drive its own console output without this module
 * needing to know about colors or dry-run formatting.
 */
function registerMcpServers(homeDir, bins, callbacks = {}) {
  const { dryRun = false, onSkip, onRegister, onWarn } = callbacks;
  const targets = buildMcpRegistrationTargets(homeDir);

  for (const target of targets) {
    if (!target.gate()) continue;
    if (dryRun) {
      if (onSkip) onSkip(target);
      continue;
    }
    registerTarget(target, bins, onRegister, onWarn);
  }

  return targets;
}

module.exports = {
  buildMcpRegistrationTargets,
  registerJson,
  registerToml,
  registerContinueYaml,
  registerZedContextServers,
  registerClaudeCli,
  quoteForCmdShell,
  registerMcpServers,
};
