#!/usr/bin/env node

const path = require('node:path');
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
  egc team init --backend <backend> --remote <url> [--branch <branch>]
  egc team sync
  egc team status

Commands:
  init     Configure a sync backend (e.g. git) and a remote URL
  sync     Pull remote lessons, merge, and push local changes
  status   Show last sync time, conflict count, and health

Options:
  --backend   Sync backend type (default: git)
  --remote    Remote URL for the sync storage
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

function handleInit(args) {
  const backendIdx = args.indexOf('--backend');
  const remoteIdx = args.indexOf('--remote');
  const branchIdx = args.indexOf('--branch');

  const backend = backendIdx !== -1 ? args[backendIdx + 1] : 'git';
  const remote = remoteIdx !== -1 ? args[remoteIdx + 1] : null;
  const branch = branchIdx !== -1 ? args[branchIdx + 1] : 'main';

  if (!remote) {
    console.error('Error: --remote is required for team init');
    process.exit(1);
  }

  const config = { backend, remote, branch };
  fs.writeFileSync(TEAM_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`Team initialized:
  Backend: ${backend}
  Remote:  ${remote}
  Branch:  ${branch}
  Config:  ${TEAM_CONFIG_PATH}`);

  // Now try to connect and set up via MCP tool.
  try {
    const result = callMcpTool('team_init', { backend, remote, branch });
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
    // Fallback: use direct git operations.
    console.log(`MCP tool failed: ${err.message}`);
    console.log('Falling back to direct sync...');
    await directSync(config);
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
  const args = process.argv.slice(3); // skip "node team.js" or "egc team"
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

function ensureRemote(syncDir, remoteUrl) {
  try {
    const current = safeGit(['remote', 'get-url', 'origin'], syncDir);
    if (current !== remoteUrl) {
      safeGit(['remote', 'set-url', 'origin', remoteUrl], syncDir);
    }
  } catch {
    safeGit(['remote', 'add', 'origin', remoteUrl], syncDir);
  }
}

function mirrorCopy(src, dest) {
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function initializeSyncRepo(syncDir, config) {
  const isRepo = fs.existsSync(path.join(syncDir, '.git'));
  if (!isRepo) {
    safeGit(['init'], syncDir);
    safeGit(['remote', 'add', 'origin', config.remote], syncDir);
  } else {
    ensureRemote(syncDir, config.remote);
  }
}

function pullRemoteChanges(syncDir, config) {
  try {
    safeGit(['pull', 'origin', config.branch, '--allow-unrelated-histories', '--no-rebase'], syncDir);
    console.log('  Pulled remote changes.');
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().trim() : err.message;
    console.log(`  Pull: ${msg.includes('no upstream') ? 'first sync, no upstream yet' : msg}`);
  }
}

function commitAndPushChanges(syncDir, config) {
  safeGit(['add', '-A'], syncDir);
  try {
    safeGit(['config', 'user.email', `${process.env.USER || process.env.USERNAME || 'egc'}@egc.local`], syncDir);
    safeGit(['config', 'user.name', process.env.USER || process.env.USERNAME || 'egc'], syncDir);
  } catch {
    // identity may already be configured
  }
  try {
    const staged = safeGit(['diff', '--cached', '--name-only'], syncDir);
    if (!staged.trim()) {
      console.log('  Nothing new to push.');
      return false;
    }
    const author = process.env.USER || process.env.USERNAME || 'unknown';
    safeGit(['commit', '-m', `sync: team memory update from ${author}`], syncDir);
    safeGit(['push', 'origin', config.branch], syncDir);
    console.log('  Pushed local changes.');
    return true;
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : err.message;
    if (msg.includes('nothing to commit')) {
      console.log('  Nothing new to push.');
    } else {
      console.log(`  Push: ${msg.trim().split('\n').pop() || 'unknown error'}`);
    }
    return false;
  }
}

async function directSync(config) {
  const syncDir = path.join(os.homedir(), '.egc', 'team-sync');
  const stateDir = path.join(os.homedir(), '.egc', 'state');

  if (!fs.existsSync(syncDir)) {
    fs.mkdirSync(syncDir, { recursive: true });
  }

  initializeSyncRepo(syncDir, config);

  // Discard uncommitted sync-repo changes before pull.
  try {
    safeGit(['reset', '--hard'], syncDir);
  } catch {
    // empty repo on first sync
  }

  pullRemoteChanges(syncDir, config);

  // Copy state files into sync repo (mirror to avoid resurrecting deleted files).
  const syncStateDir = path.join(syncDir, 'state');
  if (fs.existsSync(stateDir)) {
    mirrorCopy(stateDir, syncStateDir);
  }

  commitAndPushChanges(syncDir, config);

  console.log('Sync complete.');
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
