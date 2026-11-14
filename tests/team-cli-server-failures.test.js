/**
 * Tests for scripts/team.js against a memory server that fails: what the
 * command prints and how it exits when the server never answers, exits
 * early or refuses. The CLI finds the server by its path in the tree, so a
 * copy of the CLI runs in a temporary tree whose built server is the fake
 * of tests/fixtures/fake-memory-server.js.
 *
 * Run with: node tests/team-cli-server-failures.test.js
 */

'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEAM_KEY = 'ab'.repeat(32);

const results = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    results.push(true);
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    results.push(false);
  }
}

// The tree the copied CLI runs in: the CLI, its client, the package manifest
// they read the version from, and the fake server where the built one lives.
function makeTree(base) {
  const tree = path.join(base, 'tree');
  const copies = [
    ['scripts/team.js', 'scripts/team.js'],
    ['scripts/lib/team-mcp-client.js', 'scripts/lib/team-mcp-client.js'],
    ['scripts/lib/team-config.js', 'scripts/lib/team-config.js'],
    ['scripts/lib/team-autosync.js', 'scripts/lib/team-autosync.js'],
    ['tests/fixtures/fake-memory-server.js', 'mcp/servers/egc-memory/build/index.js'],
  ];
  for (const [from, to] of copies) {
    fs.mkdirSync(path.dirname(path.join(tree, to)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, from), path.join(tree, to));
  }
  fs.writeFileSync(path.join(tree, 'package.json'), JSON.stringify({ name: 'egc-cli-under-test', version: '0.0.0-test' }));
  return tree;
}

function runTests() {
  console.log('\n=== Testing the team CLI against a failing memory server ===\n');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-team-cli-failures-'));
  const tree = makeTree(base);
  const cli = path.join(tree, 'scripts', 'team.js');

  const home = () => fs.mkdtempSync(path.join(base, 'home-'));
  const configured = () => {
    const dir = home();
    fs.mkdirSync(path.join(dir, '.egc'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.egc', 'team.json'), JSON.stringify({ backend: 'git', remote: 'ssh://git@sync.example.invalid/team.git', branch: 'main', teamKey: TEAM_KEY }));
    return dir;
  };
  // The budget the CLI gives the server: long enough for a slow runner to
  // start the CLI and the fake server and reach the hang, short enough to
  // keep the suite quick.
  const run = (dir, args, mode, budget = '2000') => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, HOME: dir, USERPROFILE: dir, EGC_FAKE_MODE: mode, EGC_TEAM_CALL_TIMEOUT_MS: budget },
  });

  try {
    test('sync against a server that never answers exits 1, names the budget and what the server wrote, and says what a git prompt is', () => {
      const result = run(configured(), ['sync'], 'hangs');
      assert.strictEqual(result.status, 1, result.stderr);
      assert.match(result.stderr, /team sync needs the memory server \(The memory server did not answer team_sync within 2 s; the server wrote: \[memory\] git: Host key verification pending\)/);
      assert.match(result.stderr, /run "git ls-remote <remote>" once in a terminal/);
    });

    test('sync against a server that never answers the handshake exits 1 naming the handshake, with no prompt hint', () => {
      const result = run(configured(), ['sync'], 'hangs-handshake');
      assert.strictEqual(result.status, 1, result.stderr);
      assert.match(result.stderr, /team sync needs the memory server \(The memory server did not answer the handshake before team_sync within 2 s; the server wrote: \[memory\] opening the store\)/);
      assert.ok(!result.stderr.includes('git ls-remote'), 'a handshake that never came back is not a git prompt');
    });

    test('sync against a server that exits before answering exits 1 with its exit code and its last line, and no prompt hint', () => {
      const result = run(configured(), ['sync'], 'exits');
      assert.strictEqual(result.status, 1, result.stderr);
      assert.match(result.stderr, /The memory server exited with code 3 before answering team_sync; the server wrote: \[memory\] store: cannot open \/nowhere\/state\.db/);
      assert.ok(!result.stderr.includes('git ls-remote'), 'an exit is not a prompt');
    });

    test('init refused by the server exits 1 with the refusal and writes no configuration', () => {
      const dir = home();
      const result = run(dir, ['init', '--backend', 'git', '--remote', 'x', '--key', TEAM_KEY], 'refuses');
      assert.strictEqual(result.status, 1, result.stderr);
      assert.match(result.stderr, /Error: The remote x cannot be read: refused/);
      assert.match(result.stderr, /No configuration was written\./);
      assert.ok(!fs.existsSync(path.join(dir, '.egc', 'team.json')), 'the refused init leaves no team.json');
    });

    test('init against a server that never answers keeps the configuration, says so, and names the budget and the prompt', () => {
      const dir = home();
      const result = run(dir, ['init', '--backend', 'git', '--remote', 'ssh://git@sync.example.invalid/team.git', '--key', TEAM_KEY], 'hangs');
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Note: Memory server setup returned: The memory server did not answer team_init within 2 s; the server wrote: \[memory\] git: Host key verification pending/);
      assert.match(result.stdout, /run "git ls-remote <remote>" once in a terminal/);
      assert.match(result.stdout, /The config file is saved\./);
      assert.ok(fs.existsSync(path.join(dir, '.egc', 'team.json')), 'the configuration stays for the next sync');
    });

    test('init against a server that exits keeps the configuration and names the exit', () => {
      const dir = home();
      const result = run(dir, ['init', '--backend', 'git', '--remote', 'ssh://git@sync.example.invalid/team.git', '--key', TEAM_KEY], 'exits');
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Note: Memory server setup returned: The memory server exited with code 3 before answering team_init; the server wrote: \[memory\] store: cannot open \/nowhere\/state\.db/);
      assert.ok(!result.stdout.includes('git ls-remote'), 'an exit is not a prompt');
      assert.ok(fs.existsSync(path.join(dir, '.egc', 'team.json')), 'the configuration stays for the next sync');
    });

    test('a budget that is not a whole number of milliseconds a timer can hold falls back to the default instead of a zero budget', () => {
      // 2147483648 is one past what a timer holds: Node would fire it at once.
      for (const budget of ['0', '-5', 'abc', '', '500ms', '2147483648']) {
        const result = run(home(), ['init', '--backend', 'git', '--remote', 'x', '--key', TEAM_KEY], 'refuses', budget);
        assert.strictEqual(result.status, 1, `budget ${JSON.stringify(budget)}: ${result.stderr}`);
        assert.match(result.stderr, /Error: The remote x cannot be read: refused/, `budget ${JSON.stringify(budget)} let the refusal through`);
        assert.ok(!result.stderr.includes('did not answer'), `budget ${JSON.stringify(budget)} was not read as zero`);
      }
    });

    test('status against a server that exits falls back to the local checkout instead of failing', () => {
      const result = run(configured(), ['status'], 'exits');
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Remote:\s+ssh:\/\/git@sync\.example\.invalid\/team\.git/);
      assert.match(result.stdout, /Repo:\s+not initialized/);
    });

    test('status against a server that never answers falls back to the local checkout once the budget runs out', () => {
      const result = run(configured(), ['status'], 'hangs');
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Remote:\s+ssh:\/\/git@sync\.example\.invalid\/team\.git/);
      assert.match(result.stdout, /Repo:\s+not initialized/);
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests();
