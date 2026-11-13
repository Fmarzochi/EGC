#!/usr/bin/env node

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { callMcpTool: callMemoryTool } = require('./lib/team-mcp-client');

const MEMORY_SERVER_SCRIPT = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build', 'index.js');
const TEAM_CONFIG_PATH = path.join(os.homedir(), '.egc', 'team.json');
// How long one call to the memory server may take; a remote on a slow link
// can be given more through EGC_TEAM_CALL_TIMEOUT_MS (milliseconds).
const MCP_CALL_TIMEOUT_MS = callBudget(process.env.EGC_TEAM_CALL_TIMEOUT_MS, 60000);

function callBudget(raw, fallback) {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
// What a server that never answered most often waited for: a git that
// stopped to ask something no one could answer inside the server.
const GIT_PROMPT_HINT = 'A git remote that asks a question (an unknown host key, a key passphrase, a credential) cannot be answered inside the server: '
  + 'run "git ls-remote <remote>" once in a terminal and answer it there, or give git a key or a credential helper that needs no prompt.';

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
  egc team init --backend <backend> --remote <url> [--branch <branch>] [--key <hex>]
  egc team sync
  egc team status

Commands:
  init     Configure a sync backend (e.g. git) and a remote URL
  sync     Pull the teammates' sealed state, merge it, and push local state sealed with the team key
  status   Show last sync time, conflict count, and health

Options:
  --backend   Sync backend type (default: git)
  --remote    Remote URL for the sync storage
  --key       Team key (64 hex) shared by the member who initialized the team; omit to create a new team
  --branch    Git branch to use (default: main)

Examples:
  egc team init --backend git --remote git@github.com:org/egc-memory
  egc team init --backend git --remote git@github.com:org/egc-memory --branch team
  egc team sync
  egc team status
`);
}

function getTeamConfig() {
  if (!fs.existsSync(TEAM_CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(TEAM_CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
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

  const config = { backend, remote, branch, teamKey };
  // The configuration this command found, put back when the server refuses
  // the init: a sync must not run with a remote or a branch the checkout
  // does not follow.
  const previous = fs.existsSync(TEAM_CONFIG_PATH) ? fs.readFileSync(TEAM_CONFIG_PATH) : null;
  fs.mkdirSync(path.dirname(TEAM_CONFIG_PATH), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(TEAM_CONFIG_PATH), 0o700);
  } catch {
    // modes are not supported on this filesystem
  }

  publishTeamConfig(JSON.stringify(config, null, 2));
  const report = () => {
    console.log(`Team initialized:
  Backend: ${backend}
  Remote:  ${remote}
  Branch:  ${branch}
  Config:  ${TEAM_CONFIG_PATH}`);
    if (provided === undefined) {
      console.log(`Team key (share it out of band; teammates join with --key):\n  ${teamKey}`);
    }
  };

  // Now try to connect and set up via MCP tool.
  try {
    const result = await callMcpTool('team_init', { backend, remote, branch, team_key: teamKey });
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
    if (err.isTimeout) console.log(GIT_PROMPT_HINT);
    console.log('The config file is saved. Run "egc team sync" to start syncing.');
  }
}

// Writes the team configuration whole to a private temporary next to it and
// renames it into place, so an interrupted write never leaves a truncated
// file that would look like a missing team.
function publishTeamConfig(content) {
  const temporary = `${TEAM_CONFIG_PATH}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(temporary, 0o600);
  } catch {
    // modes are not supported on this filesystem
  }
  fs.renameSync(temporary, TEAM_CONFIG_PATH);
}

// Puts back the team configuration a refused init found: the file as it
// was, or none when there was none.
function restoreTeamConfig(previous) {
  if (previous === null) {
    fs.rmSync(TEAM_CONFIG_PATH, { force: true });
    return;
  }
  publishTeamConfig(previous);
}

async function handleSync() {
  const config = getTeamConfig();
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
    if (err.isTimeout) console.error(GIT_PROMPT_HINT);
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
  const config = getTeamConfig();
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
