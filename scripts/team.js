#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const MEMORY_SERVER_SCRIPT = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build', 'index.js');
const TEAM_CONFIG_PATH = path.join(os.homedir(), '.egc', 'team.json');

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

  // Parse JSON-RPC response from stdout.
  const lines = result.stdout.split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.result && parsed.result.content) {
        for (const content of parsed.result.content) {
          if (content.type === 'text') {
            try {
              return JSON.parse(content.text);
            } catch {
              return content.text;
            }
          }
        }
      }
      if (parsed.error) {
        throw new Error(parsed.error.message || 'MCP tool call failed');
      }
    } catch (e) {
      if (e.message && !e.message.includes('Unexpected token')) {
        throw e;
      }
    }
  }

  // If no JSON-RPC response, try direct output.
  const stdout = result.stdout.trim();
  if (stdout) {
    try {
      return JSON.parse(stdout);
    } catch {
      return stdout;
    }
  }

  throw new Error('No response from memory server');
}

async function main() {
  const args = process.argv.slice(3); // skip "node team.js" or "egc team"
  const firstArg = args[0];

  if (!firstArg || firstArg === '--help' || firstArg === '-h') {
    showHelp();
    process.exit(0);
  }

  switch (firstArg) {
    case 'init': {
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
      break;
    }

    case 'sync': {
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
      break;
    }

    case 'status': {
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
        // Fallback: read config.
        console.log(`Backend: ${config.backend}`);
        console.log(`Remote:  ${config.remote}`);
        console.log(`Branch:  ${config.branch}`);
        const syncDir = path.join(os.homedir(), '.egc', 'team-sync');
        const isRepo = fs.existsSync(path.join(syncDir, '.git'));
        console.log(`Repo:    ${isRepo ? 'initialized' : 'not initialized'}`);
        if (isRepo) {
          try {
            const { execSync } = require('child_process');
            const log = execSync('git log -1 --format="%ai"', { cwd: syncDir, encoding: 'utf-8' }).trim();
            if (log) console.log(`Last commit: ${log}`);
          } catch {}
        }
      }
      break;
    }

    default:
      console.error(`Unknown team subcommand: ${firstArg}`);
      showHelp();
      process.exit(1);
  }
}

async function directSync(config) {
  const { execSync } = require('child_process');
  const syncDir = path.join(os.homedir(), '.egc', 'team-sync');
  const stateDir = path.join(os.homedir(), '.egc', 'state');

  if (!fs.existsSync(syncDir)) {
    fs.mkdirSync(syncDir, { recursive: true });
  }

  // Initialize git repo if needed.
  const isRepo = fs.existsSync(path.join(syncDir, '.git'));
  if (!isRepo) {
    execSync('git init', { cwd: syncDir, stdio: 'pipe' });
    execSync(`git remote add origin ${config.remote}`, { cwd: syncDir, stdio: 'pipe' });
  }

  // Pull.
  try {
    execSync('git add -A', { cwd: syncDir, stdio: 'pipe' });
    execSync('git stash', { cwd: syncDir, stdio: 'pipe' });
  } catch {}

  try {
    execSync(`git pull origin ${config.branch} --allow-unrelated-histories --no-rebase`, { cwd: syncDir, stdio: 'pipe' });
    console.log('  Pulled remote changes.');
  } catch (err) {
    console.log(`  Pull: ${err.stderr ? err.stderr.toString().trim() : 'first sync, no upstream yet'}`);
  }

  // Copy state files into sync repo.
  const syncStateDir = path.join(syncDir, 'state');
  if (!fs.existsSync(syncStateDir)) fs.mkdirSync(syncStateDir, { recursive: true });
  if (fs.existsSync(stateDir)) {
    execSync(`robocopy "${stateDir}" "${syncStateDir}" /E /NP /NFL /NDL > nul 2>&1`, { cwd: syncDir, stdio: 'pipe' });
  }

  // Commit and push.
  execSync('git add -A', { cwd: syncDir, stdio: 'pipe' });
  try {
    const author = process.env.USER || process.env.USERNAME || 'unknown';
    execSync(`git commit -m "sync: team memory update from ${author}"`, { cwd: syncDir, stdio: 'pipe' });
    execSync(`git push origin ${config.branch}`, { cwd: syncDir, stdio: 'pipe' });
    console.log('  Pushed local changes.');
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : '';
    if (msg.includes('nothing to commit')) {
      console.log('  Nothing new to push.');
    } else {
      console.log(`  Push: ${msg.trim().split('\n').pop() || 'unknown error'}`);
    }
  }

  console.log('Sync complete.');
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
