#!/usr/bin/env node

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { callMcpTool: callMemoryTool } = require('./lib/team-mcp-client');
const { teamConfigPath, readTeamConfig, publishTeamConfigText, writeTeamConfig } = require('./lib/team-config');
const { lastAutosync } = require('./lib/team-autosync');

const MEMORY_SERVER_SCRIPT = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build', 'index.js');
const TEAM_CONFIG_PATH = teamConfigPath();
// The longest delay a Node timer takes; a larger one fires at once.
const MAX_TIMER_MS = 2147483647;
// How long one call to the memory server may take; a remote on a slow link
// can be given more through EGC_TEAM_CALL_TIMEOUT_MS (milliseconds).
const MCP_CALL_TIMEOUT_MS = callBudget(process.env.EGC_TEAM_CALL_TIMEOUT_MS, 60000);

// A budget is a whole number of milliseconds, above zero and within what a
// timer can hold; anything else is the default.
function callBudget(raw, fallback) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number(raw.trim());
  return parsed > 0 && parsed <= MAX_TIMER_MS ? parsed : fallback;
}
// What a server that took the call and never answered most often waited
// for: a git that stopped to ask something no one could answer inside the
// server. A handshake that never came back is not git's doing.
const GIT_PROMPT_HINT = 'A git remote that asks a question (an unknown host key, a key passphrase, a credential) cannot be answered inside the server: '
  + 'run "git ls-remote <remote>" once in a terminal and answer it there, or give git a key or a credential helper that needs no prompt.';

// Prints the hint after a timeout of the call itself; a server that never
// answered the handshake ran no git.
function printPromptHint(err, print) {
  if (err.isTimeout && err.initialized) print(GIT_PROMPT_HINT);
}

// Resolve absolute git path once at startup to avoid PATH-reliance.
function resolveGitBin() {
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  let output;
  try {
    output = execFileSync(lookupCmd, ['git'], { encoding: 'utf-8', stdio: 'pipe' });
  } catch (err) {
    throw new Error(`git executable not found. Install git and ensure it is on PATH. ${err.message}`, { cause: err });
  }
  const gitPath = output.split('\n').map(s => s.trim()).find(Boolean);
  if (!gitPath || !path.isAbsolute(gitPath)) {
    throw new Error(`git executable not found at an absolute path (got: ${gitPath || 'none'})`);
  }
  return gitPath;
}

const GIT_BIN = resolveGitBin();

function safeGit(args, cwd) {
  return execFileSync(GIT_BIN, args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
  }).trim();
}

function showHelp() {
  console.log(`
EGC Team Memory: Sync state across teammates

Usage:
  egc team init --backend <backend> --remote <url> [--branch <branch>] [--key <hex>] [--autosync]
  egc team sync
  egc team autosync on|off
  egc team status

Commands:
  init      Configure a sync backend (e.g. git) and a remote URL
  sync      Pull the teammates' sealed state, merge it, and push local state sealed with the team key
  autosync  Turn the sync around the session on or off: a sync when a session starts, before the
            state is read, and one after a response that changed the state (off by default)
  status    Show last sync time, conflict count, the autosync switch and its last run, and health

Options:
  --backend   Sync backend type (default: git)
  --remote    Remote URL for the sync storage
  --key       Team key (64 hex) shared by the member who initialized the team; omit to create a new team
  --branch    Git branch to use (default: main)
  --autosync  Turn the sync around the session on at init

Examples:
  egc team init --backend git --remote git@github.com:org/egc-memory
  egc team init --backend git --remote git@github.com:org/egc-memory --branch team
  egc team init --backend git --remote git@github.com:org/egc-memory --key <hex> --autosync
  egc team sync
  egc team autosync on
  egc team status
`);
}

/**
 * One MCP session with the built memory server (scripts/lib/team-mcp-client.js
 * holds the session); a server that is not built ends the command here, since
 * nothing below can run without it.
 */
function callMcpTool(toolName, args) {
  if (!fs.existsSync(MEMORY_SERVER_SCRIPT)) {
    console.error(`Memory server not built. Run "npm run build" in mcp/servers/egc-memory/`);
    process.exit(1);
  }
  return callMemoryTool(toolName, args, { serverScript: MEMORY_SERVER_SCRIPT, timeoutMs: MCP_CALL_TIMEOUT_MS });
}

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

async function handleInit(args) {
  const backend = optionValue(args, '--backend', 'git');
  const remote = optionValue(args, '--remote', null);
  const branch = optionValue(args, '--branch', 'main');
  const keyIndex = args.indexOf('--key');
  const provided = keyIndex === -1 ? undefined : args[keyIndex + 1];
  if (keyIndex !== -1 && (provided === undefined || provided.startsWith('--') || !/^[0-9a-f]{64}$/i.test(provided))) {
    console.error('Error: --key must be followed by 64 hexadecimal characters (the key shared by the member who initialized the team)');
    process.exit(1);
  }
  // The first member's key is made here, so the config is complete even
  // when the memory server cannot be reached right now.
  const teamKey = provided ?? crypto.randomBytes(32).toString('hex');
  if (!remote) {
    console.error('Error: --remote is required for team init');
    process.exit(1);
  }

  const autosync = args.includes('--autosync');
  const config = autosync ? { backend, remote, branch, teamKey, autosync } : { backend, remote, branch, teamKey };
  // The configuration this command found, put back when the server refuses
  // the init: a sync must not run with a remote or a branch the checkout
  // does not follow.
  const previous = fs.existsSync(TEAM_CONFIG_PATH) ? fs.readFileSync(TEAM_CONFIG_PATH) : null;

  writeTeamConfig(config);
  const report = () => {
    console.log(`Team initialized:
  Backend: ${backend}
  Remote:  ${remote}
  Branch:  ${branch}
  Autosync: ${autosync ? 'on' : 'off'}
  Config:  ${TEAM_CONFIG_PATH}`);
    if (provided === undefined) {
      console.log(`Team key (share it out of band; teammates join with --key):\n  ${teamKey}`);
    }
  };

  // Now try to connect and set up via MCP tool.
  try {
    const result = await callMcpTool('team_init', { backend, remote, branch, team_key: teamKey });
    // The server writes the configuration it was given, without the
    // switch, so the switch goes back on top of what it wrote.
    if (autosync) writeTeamConfig({ ...readTeamConfig(), autosync: true });
    report();
    if (result) {
      console.log('Sync backend configured successfully.');
    }
  } catch (err) {
    // A refusal by the server (a remote it cannot read, a checkout that
    // follows another remote or branch) is a failure of the init itself,
    // not of the server being away: the configuration goes back to what it
    // was, and the cause has to be fixed before anything can sync.
    if (err.isToolError) {
      restoreTeamConfig(previous);
      console.error(`Error: ${err.message}`);
      console.error(previous === null ? 'No configuration was written.' : 'The previous configuration was kept.');
      process.exit(1);
    }
    report();
    console.log(`Note: Memory server setup returned: ${err.message}`);
    printPromptHint(err, console.log);
    console.log('The config file is saved. Run "egc team sync" to start syncing.');
  }
}

// Puts back the team configuration a refused init found: the file as it
// was, or none when there was none.
function restoreTeamConfig(previous) {
  if (previous === null) {
    fs.rmSync(TEAM_CONFIG_PATH, { force: true });
    return;
  }
  publishTeamConfigText(previous);
}

// The switch of the sync around the session, in the configuration file
// where the rest of the team lives: the hooks read it on every session.
function handleAutosync(args) {
  const value = args[1];
  if (value !== 'on' && value !== 'off') {
    console.error('Error: egc team autosync takes "on" or "off"');
    process.exit(1);
  }
  const config = readTeamConfig();
  if (!config) {
    console.error('Error: Team not initialized. Run "egc team init" first.');
    process.exit(1);
  }
  const { autosync: _previous, ...rest } = config;
  writeTeamConfig(value === 'on' ? { ...rest, autosync: true } : rest);
  console.log(`Autosync: ${value}`);
  console.log(value === 'on'
    ? 'The state syncs when a session starts, before it is read, and after a response that changed it. The outcome of each run is in ~/.egc/logs/team-autosync.log.'
    : 'Nothing syncs by itself; run "egc team sync".');
}

// The autosync line of the status: the switch, and the last run when there
// was one.
function printAutosyncStatus(config) {
  const last = lastAutosync();
  const run = last?.lastRun
    ? ` (last run ${last.lastRun}, ${last.reason}, ${last.ok ? 'ok' : 'failed'}: ${last.detail})`
    : '';
  console.log(`Autosync: ${config.autosync === true ? 'on' : 'off'}${run}`);
}

async function handleSync() {
  const config = readTeamConfig();
  if (!config) {
    console.error('Error: Team not initialized. Run "egc team init" first.');
    process.exit(1);
  }

  console.log('Syncing team memory...');
  let response;
  try {
    response = await callMcpTool('team_sync', {});
  } catch (err) {
    // State leaves this machine only sealed by the memory server; the old
    // direct git fallback pushed the state directory in the clear.
    console.error(`Error: team sync needs the memory server (${err.message}). Run "egc doctor" and try again.`);
    printPromptHint(err, console.error);
    process.exit(1);
  }

  // The tool answers { success, result }, where result carries the counts and
  // the errors of the run; anything else is not a completed sync.
  const result = response?.result ?? {};
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const failed = response?.success !== true || errors.length > 0;
  console.log(failed ? 'Sync did not complete:' : 'Sync complete:');
  if (result.pulledCount !== undefined) console.log(`  Pulled: ${result.pulledCount} files`);
  if (result.pushedCount !== undefined) console.log(`  Pushed: ${result.pushedCount} commits`);
  if (result.rejectedCount !== undefined && result.rejectedCount > 0) {
    console.log(`  Rejected: ${result.rejectedCount} files (not verified team envelopes)`);
  }
  if (result.conflictCount !== undefined && result.conflictCount > 0) {
    console.log(`  Conflicts: ${result.conflictCount} (resolve manually in ~/.egc/team-sync/)`);
  }
  for (const error of errors) {
    console.error(`  Error: ${error}`);
  }
  if (failed) process.exit(1);
}

function printFallbackStatus(config) {
  console.log(`Backend: ${config.backend}`);
  console.log(`Remote:  ${config.remote}`);
  console.log(`Branch:  ${config.branch}`);
  const syncDir = path.join(os.homedir(), '.egc', 'team-sync');
  const isRepo = fs.existsSync(path.join(syncDir, '.git'));
  console.log(`Repo:    ${isRepo ? 'initialized' : 'not initialized'}`);
  if (isRepo) {
    try {
      const log = safeGit(['log', '-1', '--format=%ai'], syncDir);
      if (log) console.log(`Last commit: ${log}`);
    } catch {
      // no commits yet
    }
  }
}

async function handleStatus() {
  const config = readTeamConfig();
  if (!config) {
    console.error('Error: Team not initialized. Run "egc team init" first.');
    process.exit(1);
  }

  try {
    // The tool answers { success, status }, where status carries the fields.
    const status = (await callMcpTool('team_status', {}))?.status ?? {};
    if (status.lastSyncTime) console.log(`Last sync: ${status.lastSyncTime}`);
    if (status.hasUncommittedChanges !== undefined) console.log(`Uncommitted changes: ${status.hasUncommittedChanges}`);
    if (status.conflictCount !== undefined && status.conflictCount > 0) console.log(`Conflicts: ${status.conflictCount}`);
    console.log(`Remote: ${status.remoteUrl || config.remote}`);
  } catch {
    printFallbackStatus(config);
  }
  printAutosyncStatus(config);
}

async function main() {
  // egc.js already strips the "team" command word before spawning this script,
  // so argv is ["node", "team.js", ...subcommandArgs]; slice(2) keeps them.
  const args = process.argv.slice(2);
  const firstArg = args[0];

  if (!firstArg || firstArg === '--help' || firstArg === '-h') {
    showHelp();
    process.exit(0);
  }

  switch (firstArg) {
    case 'init':
      await handleInit(args);
      break;

    case 'sync':
      await handleSync();
      break;

    case 'autosync':
      handleAutosync(args);
      break;

    case 'status':
      await handleStatus();
      break;

    default:
      console.error(`Unknown team subcommand: ${firstArg}`);
      showHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
