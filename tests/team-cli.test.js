/**
 * Tests for the `egc team` CLI talking to the built memory server over stdio:
 * `team init` configures the sync backend through the server, `team sync`
 * completes through it, and the only thing the push commits is sealed state.
 * The CLI once sent a bare tools/call with no MCP initialize and the server
 * never answered ("No response from memory server"), so the Team Brain could
 * not be driven from the command line at all. Runs with a home of its own
 * against the built memory server.
 */
'use strict';

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEAM_CLI = path.join(ROOT, 'scripts', 'team.js');
const MEMORY_SERVER = path.join(ROOT, 'mcp', 'servers', 'egc-memory', 'build', 'index.js');

// Fixed git locations before a PATH lookup.
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

// The CLI and the server both read the home directory, so the suite runs with
// a home of its own: the real ~/.egc is never read, touched or shipped.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-team-cli-home-'));
const REMOTE = path.join(HOME, 'team-remote');
const PROJECT = path.join(HOME, 'project');
// The repository's budget for one spawned process in a test.
const CLI_TIMEOUT_MS = 30000;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function git(args, cwd) {
  return execFileSync(GIT_BIN, args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function bareRemote(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '--bare', '-q'], dir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
}

function remoteTree(remote, branch) {
  try {
    return git(['ls-tree', '-r', '--name-only', branch], remote).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function teamCli(args) {
  return spawnSync(process.execPath, [TEAM_CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME, USERPROFILE: HOME },
    timeout: CLI_TIMEOUT_MS,
  });
}

// One update_state through the server, so the sync has state to ship.
function writeProjectState() {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'team-cli-test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'update_state', arguments: { project_path: PROJECT, context: 'Team CLI test project.' } } },
  ];
  const run = spawnSync(process.execPath, [MEMORY_SERVER], {
    input: messages.map(m => JSON.stringify(m)).join('\n') + '\n',
    encoding: 'utf8',
    env: { ...process.env, HOME, USERPROFILE: HOME },
    timeout: CLI_TIMEOUT_MS,
  });
  assert.ok(run.stdout.includes('Project memory updated'), `update_state did not go through:\n${run.stdout}\n${run.stderr}`);
}

function runTests() {
  console.log('\nteam CLI against the built memory server');
  if (!fs.existsSync(MEMORY_SERVER)) {
    console.error(`[SKIP] memory server build not found at ${MEMORY_SERVER}. Run 'npm run build' in mcp/servers/egc-memory first.`);
    fs.rmSync(HOME, { recursive: true, force: true });
    process.exit(0);
  }
  let passed = 0;
  let failed = 0;

  try {
    bareRemote(REMOTE);
    fs.mkdirSync(PROJECT, { recursive: true });

    if (test('team init configures the sync backend through the memory server', () => {
      const run = teamCli(['init', '--backend', 'git', '--remote', REMOTE]);
      assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.ok(run.stdout.includes('Team key'), 'a new team prints its key once');
      assert.ok(!run.stdout.includes('Memory server setup returned'), `the server did not answer the CLI:\n${run.stdout}`);
      assert.ok(run.stdout.includes('Sync backend configured successfully.'), run.stdout);
      const config = JSON.parse(fs.readFileSync(path.join(HOME, '.egc', 'team.json'), 'utf8'));
      assert.strictEqual(config.backend, 'git');
      assert.strictEqual(config.remote, REMOTE);
      assert.match(config.teamKey, /^[0-9a-f]{64}$/);
    })) passed++; else failed++;

    if (test('team sync completes through the memory server, reports the counts and ships only sealed state', () => {
      writeProjectState();
      const run = teamCli(['sync']);
      assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.ok(!run.stderr.includes('No response from memory server'), run.stderr);
      assert.ok(run.stdout.includes('Sync complete:'), run.stdout);
      assert.ok(run.stdout.includes('Pulled: 0 files'), `an empty remote pulls nothing:\n${run.stdout}`);
      assert.ok(run.stdout.includes('Pushed: 1 commits'), `the first sync pushes one commit:\n${run.stdout}`);
      const tree = remoteTree(REMOTE, 'main');
      assert.ok(tree.some(entry => entry.startsWith('state/')), `the sealed state reaches the remote, got: ${tree.join(', ') || 'nothing'}`);
      assert.deepStrictEqual(tree.filter(entry => entry.startsWith('memory/')), [], 'the memory database never ships');
    })) passed++; else failed++;

    if (test('team status answers through the memory server with its fields', () => {
      const run = teamCli(['status']);
      assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.ok(!run.stderr.includes('No response from memory server'), run.stderr);
      assert.ok(run.stdout.includes(`Remote: ${REMOTE}`), run.stdout);
      assert.match(run.stdout, /Uncommitted changes: (true|false)/, 'the status fields come from the server answer');
    })) passed++; else failed++;

    if (test('team sync fails loudly when the server reports errors', () => {
      const configPath = path.join(HOME, '.egc', 'team.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      fs.writeFileSync(configPath, JSON.stringify({ ...config, teamKey: 'not-a-key' }, null, 2));
      const run = teamCli(['sync']);
      assert.notStrictEqual(run.status, 0, 'a sync the server could not do is not a success');
      assert.ok(`${run.stdout}\n${run.stderr}`.includes('Team key missing or invalid'), `${run.stdout}\n${run.stderr}`);
    })) passed++; else failed++;
  } finally {
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
