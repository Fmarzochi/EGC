#!/usr/bin/env node

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');

const MEMORY_SERVER_SCRIPT = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build', 'index.js');
const TEAM_CONFIG_PATH = path.join(os.homedir(), '.egc', 'team.json');

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
EGC Team Memory — Sync state across teammates

Usage:
  egc team init --backend <backend> --remote <url> [--branch <branch>] [--key <hex>]
  egc team sync
  egc team status

Commands:
  init     Configure a sync backend (e.g. git) and a remote URL
  sync     Pull remote lessons, merge, and push local changes
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
 * Parse one JSONL line of MCP output. Returns { value } when the line holds
 * a text result, null when the line should be skipped (not JSON, or no text
 * content), and throws when the line carries an MCP error payload.
 */
function extractMcpLineResult(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed.result?.content) {
    for (const content of parsed.result.content) {
      if (content.type === 'text') {
        return { value: parseJsonOrRaw(content.text) };
      }
    }
  }
  if (parsed.error) {
    throw new Error(parsed.error.message || 'MCP tool call failed');
  }
  return null;
}

function parseMcpResponse(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  for (const line of lines) {
    const result = extractMcpLineResult(line);
    if (result) {
      return result.value;
    }
  }

  const stdoutTrimmed = stdout.trim();
  if (stdoutTrimmed) {
    return parseJsonOrRaw(stdoutTrimmed);
  }

  throw new Error('No response from memory server');
}

function callMcpTool(toolName, args) {
  if (!fs.existsSync(MEMORY_SERVER_SCRIPT)) {
    console.error(`Memory server not built. Run "npm run build" in mcp/servers/egc-memory/`);
    process.exit(1);
  }

  const input = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  });

  const result = spawnSync(process.execPath, [MEMORY_SERVER_SCRIPT], {
    input,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, EGC_CLI_MODE: '1' },
  });

  if (result.error) throw result.error;

  return parseMcpResponse(result.stdout);
}

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function handleInit(args) {
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
    const result = callMcpTool('team_init', { backend, remote, branch, team_key: teamKey });
    if (result) {
      console.log('Sync backend configured successfully.');
    }
  } catch (err) {
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
  try {
    const result = callMcpTool('team_sync', {});
    console.log('Sync complete:');
    if (result.pulledCount !== undefined) console.log(`  Pulled: ${result.pulledCount} files`);
    if (result.pushedCount !== undefined) console.log(`  Pushed: ${result.pushedCount} commits`);
    if (result.conflictCount !== undefined && result.conflictCount > 0) {
      console.log(`  Conflicts: ${result.conflictCount} (resolve manually in ~/.egc/team-sync/)`);
    }
    if (result.errors && result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.join(', ')}`);
    }
  } catch (err) {
    // State leaves this machine only sealed by the memory server; the old
    // direct git fallback pushed the state directory in the clear.
    console.error(`Error: team sync needs the memory server (${err.message}). Run "egc doctor" and try again.`);
    process.exit(1);
  }
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

function handleStatus() {
  const config = getTeamConfig();
  if (!config) {
    console.error('Error: Team not initialized. Run "egc team init" first.');
    process.exit(1);
  }

  try {
    const result = callMcpTool('team_status', {});
    if (result.lastSyncTime) console.log(`Last sync: ${result.lastSyncTime}`);
    if (result.hasUncommittedChanges !== undefined) console.log(`Uncommitted changes: ${result.hasUncommittedChanges}`);
    if (result.conflictCount !== undefined && result.conflictCount > 0) console.log(`Conflicts: ${result.conflictCount}`);
    console.log(`Remote: ${result.remoteUrl || config.remote}`);
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
      handleInit(args);
      break;

    case 'sync':
      await handleSync();
      break;

    case 'status':
      handleStatus();
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
