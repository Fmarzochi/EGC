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

const { removeDirWithRetries } = require('./fixtures/remove-dir');
const { FULL_INSTALL_TIMEOUT_MS } = require('./fixtures/subprocess-timeouts');
const { suiteEnv } = require('./fixtures/suite-env');

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
// Every child (git, the CLI, the server) runs with the suite environment and
// the isolated home. One CLI call spawns the server, its migrations and a
// chain of git commands, so it gets the larger of the repository's budgets.
const TEST_ENV = { ...suiteEnv(process.env), HOME, USERPROFILE: HOME };
const CLI_TIMEOUT_MS = FULL_INSTALL_TIMEOUT_MS;

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
  return execFileSync(GIT_BIN, args, { cwd, encoding: 'utf8', env: TEST_ENV, stdio: 'pipe' }).trim();
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
    env: TEST_ENV,
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
    env: TEST_ENV,
    timeout: CLI_TIMEOUT_MS,
  });
  assert.ok(run.stdout.includes('Project memory updated'), `update_state did not go through:\n${run.stdout}\n${run.stderr}`);
}

function runTests() {
  console.log('\nteam CLI against the built memory server');
  if (!fs.existsSync(MEMORY_SERVER)) {
    console.error(`[SKIP] memory server build not found at ${MEMORY_SERVER}. Run 'npm run build' in mcp/servers/egc-memory first.`);
    removeDirWithRetries(HOME);
    process.exit(0);
  }
  let passed = 0;
  let failed = 0;
  const run = (name, fn) => {
    if (test(name, fn)) passed++; else failed++;
  };

  try {
    bareRemote(REMOTE);
    fs.mkdirSync(PROJECT, { recursive: true });

    run('team init configures the sync backend through the memory server', () => {
      const run = teamCli(['init', '--backend', 'git', '--remote', REMOTE]);
      assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.ok(run.stdout.includes('Team key'), 'a new team prints its key once');
      assert.ok(!run.stdout.includes('Memory server setup returned'), `the server did not answer the CLI:\n${run.stdout}`);
      assert.ok(run.stdout.includes('Sync backend configured successfully.'), run.stdout);
      const config = JSON.parse(fs.readFileSync(path.join(HOME, '.egc', 'team.json'), 'utf8'));
      assert.strictEqual(config.backend, 'git');
      assert.strictEqual(config.remote, REMOTE);
      assert.match(config.teamKey, /^[0-9a-f]{64}$/);
    });

    run('team sync completes through the memory server, reports the counts and ships only sealed state', () => {
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
    });

    run('team status answers through the memory server with its fields', () => {
      const run = teamCli(['status']);
      assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.ok(!run.stderr.includes('No response from memory server'), run.stderr);
      assert.ok(run.stdout.includes(`Remote: ${REMOTE}`), run.stdout);
      assert.match(run.stdout, /Uncommitted changes: (true|false)/, 'the status fields come from the server answer');
    });

    run('team init against a remote that cannot be read exits 1 and names it', () => {
      const configPath = path.join(HOME, '.egc', 'team.json');
      const saved = fs.readFileSync(configPath, 'utf8');
      const run = teamCli(['init', '--backend', 'git', '--remote', path.join(HOME, 'no-such-remote')]);
      assert.notStrictEqual(run.status, 0, `an init whose remote cannot be read is not a success:\n${run.stdout}\n${run.stderr}`);
      assert.ok(`${run.stdout}\n${run.stderr}`.includes('cannot be read'), `${run.stdout}\n${run.stderr}`);
      fs.writeFileSync(configPath, saved);
    });

    run('team sync against a remote that cannot be read exits 1 with the reason, never a quiet success', () => {
      const configPath = path.join(HOME, '.egc', 'team.json');
      const saved = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(saved);
      fs.writeFileSync(configPath, JSON.stringify({ ...config, remote: path.join(HOME, 'no-such-remote') }, null, 2));
      const run = teamCli(['sync']);
      assert.notStrictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.ok(!run.stdout.includes('Sync complete:'), `a sync that read nothing is not complete:\n${run.stdout}`);
      assert.ok(`${run.stdout}\n${run.stderr}`.includes('cannot be read'), `${run.stdout}\n${run.stderr}`);
      fs.writeFileSync(configPath, saved);
    });

    run('team sync with a key that opens nothing on the remote pushes nothing, so the shared state survives a wrong key', () => {
      const configPath = path.join(HOME, '.egc', 'team.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const before = remoteTree(REMOTE, 'main');
      const commitsBefore = git(['rev-list', '--count', 'main'], REMOTE);
      fs.writeFileSync(configPath, JSON.stringify({ ...config, teamKey: 'f'.repeat(64) }, null, 2));
      const run = teamCli(['sync']);
      assert.notStrictEqual(run.status, 0, `a sync whose key opened nothing is not a success:\n${run.stdout}\n${run.stderr}`);
      assert.ok(`${run.stdout}\n${run.stderr}`.includes('nothing was pushed'), `${run.stdout}\n${run.stderr}`);
      assert.deepStrictEqual(remoteTree(REMOTE, 'main'), before, 'the shared state is exactly what it was');
      assert.strictEqual(git(['rev-list', '--count', 'main'], REMOTE), commitsBefore, 'no commit reached the remote');
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    });

    run('team sync fails loudly when the server reports errors', () => {
      const configPath = path.join(HOME, '.egc', 'team.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      fs.writeFileSync(configPath, JSON.stringify({ ...config, teamKey: 'not-a-key' }, null, 2));
      const run = teamCli(['sync']);
      assert.notStrictEqual(run.status, 0, 'a sync the server could not do is not a success');
      assert.ok(`${run.stdout}\n${run.stderr}`.includes('Team key missing or invalid'), `${run.stdout}\n${run.stderr}`);
    });
  } finally {
    removeDirWithRetries(HOME);
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
