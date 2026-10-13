'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
// Quote what double quotes actually neutralize in cmd.exe: whitespace,
// quotes, and shell metacharacters. Deliberately NOT % or !: cmd expands
// %var% (and !var! under delayed expansion) even inside double quotes, so
// including them would only pretend a safety this quoting cannot provide.
// Embedded quotes double, the cmd convention. POSIX callers never hit this
// path (shell stays false there).
function quoteForCmdShell(arg) {
  if (!/[\s"^&|<>()]/.test(arg)) return arg;
  return '"' + arg.replaceAll('"', '""') + '"';
}

// npm puts a global package's command on Windows as a .cmd shim beside its
// node_modules, and that shim only runs the package's own script with node:
// running the script directly needs no shell at all.
function claudeScriptBehindShim(cli) {
  const script = path.join(path.dirname(cli), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  return fs.existsSync(script) ? script : null;
}

// How to run the claude CLI with an argv: the executable itself, the script
// behind its .cmd shim with node, or, with neither, through cmd.exe, which
// expands %var% and !var! whatever the quoting; a path holding either, the
// CLI's own included, is refused there rather than handed over changed. The
// way by hand is the entry for ~/.claude.json, since typing the add again
// would go through the same cmd.exe.
function manualClaudeEntry([name, bin]) {
  return `${JSON.stringify(name)}: ${JSON.stringify({ type: 'stdio', command: 'node', args: [bin] })}`;
}

const CMD_EXPANDS = /[%!]/;

function byHand(cli, expanded, pending) {
  return new Error(`cmd.exe would expand the % or ! in '${expanded}', so ${pending.map(([name]) => name).join(' and ')} cannot be registered through ${path.basename(cli)}; with Claude Code closed, add by hand under "mcpServers" in ${path.join(os.homedir(), '.claude.json')}: ${pending.map(manualClaudeEntry).join(', ')}`);
}

function claudeRunner(cli) {
  // Same Windows rule as the crusher shim: .cmd/.bat need a shell.
  const { needsShellOnWindows } = require('./crusher/shim-dispatch');
  if (!needsShellOnWindows(cli)) return { viaCmd: false, run: args => spawnSync(cli, args, { encoding: 'utf8' }) }; // NOSONAR javascript:S4036 -- cli was resolved from the user's own PATH on purpose; fixed argv
  const script = claudeScriptBehindShim(cli);
  if (script) return { viaCmd: false, run: args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' }) };
  return { viaCmd: true, run: args => spawnSync(quoteForCmdShell(cli), args.map(quoteForCmdShell), { encoding: 'utf8', shell: true }) }; // NOSONAR javascript:S4036 -- cli was resolved from the user's own PATH on purpose; fixed argv
}

// One server through the CLI: 'present' when it is registered already,
// 'refused' when cmd.exe would expand its path, 'added' once the add ran.
function addClaudeServer(runCli, viaCmd, name, bin) {
  const existing = runCli(['mcp', 'get', name]);
  // A CLI that cannot even run is not "server missing" - surface it
  // instead of piling a doomed `add` on top.
  if (existing.error) throw existing.error;
  if (existing.status === 0) return 'present';
  if (viaCmd && CMD_EXPANDS.test(bin)) return 'refused';
  const added = runCli(['mcp', 'add', '-s', 'user', name, '--', 'node', bin]);
  if (added.error) throw added.error;
  if (added.status !== 0) {
    throw new Error(`claude mcp add ${name} failed: ${(added.stderr || added.stdout || '').trim()}`);
  }
  return 'added';
}

function registerClaudeCli(_targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  const cli = resolveClaudeCli();
  if (!cli) throw new Error('claude CLI not found on PATH');

  const servers = [
    ['egc-guardian', guardianBin],
    ['egc-memory', memoryBin],
  ];
  const { run: runCli, viaCmd } = claudeRunner(cli);
  // Through cmd.exe, a CLI path it would expand cannot run at all, and a
  // server path it would expand is left for the way by hand, every such
  // server named, after the others are registered.
  if (viaCmd && CMD_EXPANDS.test(cli)) throw byHand(cli, cli, servers);
  const outcomes = servers.map(([name, bin]) => addClaudeServer(runCli, viaCmd, name, bin));
  const refused = servers.filter((_, at) => outcomes[at] === 'refused');
  if (refused.length > 0) throw byHand(cli, refused[0][1], refused);
  return outcomes.includes('added');
}

module.exports = {
  resolveClaudeCli,
  quoteForCmdShell,
  registerClaudeCli,
};
