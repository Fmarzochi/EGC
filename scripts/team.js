#!/usr/bin/env node

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const MEMORY_SERVER_SCRIPT = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build', 'index.js');
const TEAM_CONFIG_PATH = path.join(os.homedir(), '.egc', 'team.json');
const PACKAGE_VERSION = require('../package.json').version;
const MCP_PROTOCOL_VERSION = '2024-11-05';
const MCP_INITIALIZE_ID = 1;
const MCP_CALL_ID = 2;
const MCP_CALL_TIMEOUT_MS = 60000;

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

function parseJsonOrRaw(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Parse one line of the server's stdout as a JSON-RPC message. Anything that
 * is not a JSON object (log noise, a bare value, an array) is skipped.
 */
function parseJsonRpcLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

/**
 * The value of a tools/call answer: its first text content, parsed as JSON
 * when it is JSON. Throws on a JSON-RPC error, on a tool result flagged
 * isError, and on an answer with no text.
 */
function toolCallValue(message) {
  if (message.error) {
    throw new Error(message.error.message || 'MCP tool call failed');
  }
  const content = Array.isArray(message.result?.content) ? message.result.content : [];
  const text = content.find(item => item.type === 'text');
  if (message.result?.isError) {
    throw new Error(text ? text.text : 'MCP tool call failed');
  }
  if (!text) {
    throw new Error('No response from memory server');
  }
  return parseJsonOrRaw(text.text);
}

/**
 * One MCP session with the memory server over stdio: initialize, wait for its
 * answer, then the initialized notification and the tool call, and wait for
 * the answer that carries the call's id. Stdin stays open until that answer
 * arrives, the server exits when stdin closes, and the promise settles only
 * once the server has exited, so no caller goes on while the server still
 * holds the memory database.
 */
function callMcpTool(toolName, args) {
  if (!fs.existsSync(MEMORY_SERVER_SCRIPT)) {
    console.error(`Memory server not built. Run "npm run build" in mcp/servers/egc-memory/`);
    process.exit(1);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MEMORY_SERVER_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'] });
    let initialized = false;
    let outcome = null;
    let buffer = '';

    const record = (error, value) => {
      if (outcome) return;
      outcome = { error, value };
      child.stdin.end();
    };
    const timer = setTimeout(() => {
      record(new Error('No response from memory server'));
      child.kill();
    }, MCP_CALL_TIMEOUT_MS);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');

    const onMessage = message => {
      if (!initialized && message.id === MCP_INITIALIZE_ID) {
        if (message.error) {
          record(new Error(message.error.message || 'MCP initialize failed'));
          return;
        }
        initialized = true;
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: MCP_CALL_ID, method: 'tools/call', params: { name: toolName, arguments: args } });
        return;
      }
      if (message.id === MCP_CALL_ID) {
        try {
          record(null, toolCallValue(message));
        } catch (error) {
          record(error);
        }
      }
    };

    child.stdin.on('error', error => record(error));
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', chunk => {
      const lines = (buffer + chunk).split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (outcome) break;
        const message = parseJsonRpcLine(line);
        if (message) onMessage(message);
      }
    });
    child.on('error', error => record(error));
    child.on('close', () => {
      clearTimeout(timer);
      const { error, value } = outcome || { error: new Error('No response from memory server') };
      if (error) reject(error);
      else resolve(value);
    });

    send({
      jsonrpc: '2.0',
      id: MCP_INITIALIZE_ID,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'egc-team', version: PACKAGE_VERSION },
      },
    });
  });
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
  fs.mkdirSync(path.dirname(TEAM_CONFIG_PATH), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(TEAM_CONFIG_PATH), 0o700);
  } catch {
    // modes are not supported on this filesystem
  }

  fs.writeFileSync(TEAM_CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(TEAM_CONFIG_PATH, 0o600);
  } catch {
    // modes are not supported on this filesystem
  }
  console.log(`Team initialized:
  Backend: ${backend}
  Remote:  ${remote}
  Branch:  ${branch}
  Config:  ${TEAM_CONFIG_PATH}`);
  if (provided === undefined) {
    console.log(`Team key (share it out of band; teammates join with --key):\n  ${teamKey}`);
  }

  // Now try to connect and set up via MCP tool.
  try {
    const result = await callMcpTool('team_init', { backend, remote, branch, team_key: teamKey });
    if (result) {
      console.log('Sync backend configured successfully.');
    }
  } catch (err) {
    // A remote the server could not read is a failure of the init itself,
    // not of the server being away: the URL or the access has to be fixed
    // before anything can sync.
    if (/cannot be read/.test(err.message)) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    console.log(`Note: Memory server setup returned: ${err.message}`);
    console.log('The config file is saved. Run "egc team sync" to start syncing.');
  }
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
