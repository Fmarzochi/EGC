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
const crypto = require('crypto');
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

// Every file under a directory with the hash of its content, so two
// snapshots of a tree compare whole: paths, contents, nothing added, nothing
// changed.
function treeDigest(root) {
  const digest = {};
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else digest[path.relative(root, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return digest;
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
      assert.deepStrictEqual(tree.filter(entry => entry.endsWith('.hmac')), [], 'the integrity sidecars never ship');
      assert.ok(tree.includes('TEAM'), `the marker of the team key travels with the first push: ${tree.join(', ')}`);
      const marker = git(['show', 'main:TEAM'], REMOTE).trim();
      assert.match(marker, /^[0-9a-f]{64}$/, 'the marker is 64 hex characters');
      assert.notStrictEqual(marker, JSON.parse(fs.readFileSync(path.join(HOME, '.egc', 'team.json'), 'utf8')).teamKey, 'the marker is not the key');
    });

    run('team sync says a marker damaged on the remote as a warning, writes it again and still exits 0', () => {
      const marker = git(['show', 'main:TEAM'], REMOTE).trim();
      // Somebody edited the marker in the repository: the checkout of this
      // machine pushes the damaged text, as another machine would have.
      const checkout = path.join(HOME, '.egc', 'team-sync');
      fs.writeFileSync(path.join(checkout, 'TEAM'), `${'a'.repeat(64)}\n`);
      git(['add', 'TEAM'], checkout);
      git(['-c', 'user.name=other', '-c', 'user.email=other@egc.local', 'commit', '-q', '-m', 'a damaged marker'], checkout);
      git(['push', '-q', 'origin', 'main'], checkout);
      assert.strictEqual(git(['show', 'main:TEAM'], REMOTE).trim(), 'a'.repeat(64), 'the remote holds the damaged marker');

      const run = teamCli(['sync']);
      assert.strictEqual(run.status, 0, `a damaged marker next to files the key opens is not a failure:\n${run.stdout}\n${run.stderr}`);
      assert.ok(run.stdout.includes('Sync complete:'), run.stdout);
      assert.ok(run.stdout.includes('Warning: The TEAM marker of'), `the damage is said:\n${run.stdout}`);
      assert.ok(run.stdout.includes('written again with this sync'), run.stdout);
      assert.strictEqual(git(['show', 'main:TEAM'], REMOTE).trim(), marker, 'the marker of the team is back on the remote');
      assert.strictEqual(fs.readFileSync(path.join(checkout, 'TEAM'), 'utf8').trim(), marker, 'and in the checkout');
    });

    run('team init with a key that is not the team\'s against a repository that names its team exits 1 and keeps the previous configuration', () => {
      const configPath = path.join(HOME, '.egc', 'team.json');
      const saved = fs.readFileSync(configPath, 'utf8');
      try {
        const run = teamCli(['init', '--backend', 'git', '--remote', REMOTE, '--key', 'e'.repeat(64)]);
        assert.strictEqual(run.status, 1, `a key that is not the team's is refused:\n${run.stdout}\n${run.stderr}`);
        assert.ok(`${run.stdout}\n${run.stderr}`.includes('This key is not the key of the team that uses'), `${run.stdout}\n${run.stderr}`);
        assert.strictEqual(fs.readFileSync(configPath, 'utf8'), saved, 'the configuration this machine had is put back');
      } finally {
        fs.writeFileSync(configPath, saved);
      }
    });

    run('team status answers through the memory server with its fields', () => {
      const run = teamCli(['status']);
      assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.ok(!run.stderr.includes('No response from memory server'), run.stderr);
      assert.ok(run.stdout.includes(`Remote: ${REMOTE}`), run.stdout);
      assert.match(run.stdout, /Uncommitted changes: (true|false)/, 'the status fields come from the server answer');
    });

    run('team init against another remote on a machine that already has a checkout exits 1, says what to do and keeps the previous configuration', () => {
      const configPath = path.join(HOME, '.egc', 'team.json');
      const saved = fs.readFileSync(configPath, 'utf8');
      try {
        const run = teamCli(['init', '--backend', 'git', '--remote', path.join(HOME, 'no-such-remote')]);
        assert.strictEqual(run.status, 1, `an init the checkout does not follow exits 1:\n${run.stdout}\n${run.stderr}`);
        assert.ok(`${run.stdout}\n${run.stderr}`.includes('Remove that directory'), `${run.stdout}\n${run.stderr}`);
        assert.ok(!run.stdout.includes('Team initialized'), `a refused init reports no team:\n${run.stdout}`);
        assert.strictEqual(fs.readFileSync(configPath, 'utf8'), saved, 'the configuration this machine had is put back');
      } finally {
        fs.writeFileSync(configPath, saved);
      }
    });

    run('team init with another branch on a machine that already has a checkout exits 1, says what to do and keeps the previous configuration', () => {
      const configPath = path.join(HOME, '.egc', 'team.json');
      const saved = fs.readFileSync(configPath, 'utf8');
      try {
        const run = teamCli(['init', '--backend', 'git', '--remote', REMOTE, '--branch', 'elsewhere', '--key', JSON.parse(saved).teamKey]);
        assert.strictEqual(run.status, 1, `an init the checkout does not follow exits 1:\n${run.stdout}\n${run.stderr}`);
        assert.ok(`${run.stdout}\n${run.stderr}`.includes('Remove that directory'), `${run.stdout}\n${run.stderr}`);
        assert.strictEqual(fs.readFileSync(configPath, 'utf8'), saved, 'the configuration this machine had is put back');
      } finally {
        fs.writeFileSync(configPath, saved);
      }
    });

    run('team sync against a remote that cannot be read exits 1 with the reason, never a quiet success', () => {
      // The remote is moved away, so the checkout still follows the
      // configuration and the failure is the read of the remote itself.
      const away = `${REMOTE}.away`;
      fs.renameSync(REMOTE, away);
      try {
        const run = teamCli(['sync']);
        assert.strictEqual(run.status, 1, `a sync whose remote cannot be read exits 1:\n${run.stdout}\n${run.stderr}`);
        assert.ok(!run.stdout.includes('Sync complete:'), `a sync that read nothing is not complete:\n${run.stdout}`);
        assert.ok(`${run.stdout}\n${run.stderr}`.includes('cannot be read'), `${run.stdout}\n${run.stderr}`);
      } finally {
        fs.renameSync(away, REMOTE);
      }
    });

    run('team sync with a configuration changed by hand to another remote stops with the checkout it follows', () => {
      const configPath = path.join(HOME, '.egc', 'team.json');
      const saved = fs.readFileSync(configPath, 'utf8');
      fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(saved), remote: path.join(HOME, 'no-such-remote') }, null, 2));
      try {
        const run = teamCli(['sync']);
        assert.strictEqual(run.status, 1, `a sync the checkout does not follow exits 1:\n${run.stdout}\n${run.stderr}`);
        assert.ok(`${run.stdout}\n${run.stderr}`.includes('Remove that directory'), `${run.stdout}\n${run.stderr}`);
      } finally {
        fs.writeFileSync(configPath, saved);
      }
    });

    run('team status answers from the local checkout while the remote cannot be read', () => {
      const away = `${REMOTE}.away`;
      fs.renameSync(REMOTE, away);
      try {
        const run = teamCli(['status']);
        assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
        assert.ok(run.stdout.includes('Remote:'), `the status still reports the checkout:\n${run.stdout}`);
      } finally {
        fs.renameSync(away, REMOTE);
      }
    });

    run('team sync with a key that is not the team\'s stops at the marker before any file is merged, so the shared state survives a wrong key', () => {
      const configPath = path.join(HOME, '.egc', 'team.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const before = remoteTree(REMOTE, 'main');
      const commitsBefore = git(['rev-list', '--count', 'main'], REMOTE);
      const localState = treeDigest(path.join(HOME, '.egc', 'state'));
      fs.writeFileSync(configPath, JSON.stringify({ ...config, teamKey: 'f'.repeat(64) }, null, 2));
      try {
        const run = teamCli(['sync']);
        assert.notStrictEqual(run.status, 0, `a sync with a key that is not the team's is not a success:\n${run.stdout}\n${run.stderr}`);
        assert.ok(`${run.stdout}\n${run.stderr}`.includes('This key is not the key of the team that uses'), `${run.stdout}\n${run.stderr}`);
        assert.deepStrictEqual(remoteTree(REMOTE, 'main'), before, 'the shared state is exactly what it was');
        assert.strictEqual(git(['rev-list', '--count', 'main'], REMOTE), commitsBefore, 'no commit reached the remote');
        assert.deepStrictEqual(treeDigest(path.join(HOME, '.egc', 'state')), localState, 'no local state file was written or changed, anywhere under the tree');
      } finally {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      }
    });

    run('team init without a key against a repository from before the marker that holds state is refused, and the next sync writes the marker', () => {
      const checkout = path.join(HOME, '.egc', 'team-sync');
      const configPath = path.join(HOME, '.egc', 'team.json');
      const saved = fs.readFileSync(configPath, 'utf8');
      try {
        // The repository loses its marker, as a repository made by an older
        // version never had one, and keeps its state files.
        git(['rm', '-q', 'TEAM'], checkout);
        git(['-c', 'user.name=older', '-c', 'user.email=older@egc.local', 'commit', '-q', '-m', 'a repository without the marker'], checkout);
        git(['push', '-q', 'origin', 'main'], checkout);
        assert.ok(!remoteTree(REMOTE, 'main').includes('TEAM'), 'the remote has no marker');
        assert.ok(remoteTree(REMOTE, 'main').some(entry => entry.startsWith('state/')), 'and still holds state');

        const run = teamCli(['init', '--backend', 'git', '--remote', REMOTE]);
        assert.strictEqual(run.status, 1, `a new key against state it cannot open is refused:\n${run.stdout}\n${run.stderr}`);
        assert.ok(`${run.stdout}\n${run.stderr}`.includes('opens none of the state files'), `${run.stdout}\n${run.stderr}`);
        assert.strictEqual(fs.readFileSync(configPath, 'utf8'), saved, 'the configuration this machine had is put back');

        const sync = teamCli(['sync']);
        assert.strictEqual(sync.status, 0, `${sync.stdout}\n${sync.stderr}`);
        assert.ok(remoteTree(REMOTE, 'main').includes('TEAM'), 'the sync with the key of the team writes the marker again');
      } finally {
        // The later cases need the team as it was: its configuration, and
        // its marker on the remote, written back by a sync with the key.
        fs.writeFileSync(configPath, saved);
        if (!remoteTree(REMOTE, 'main').includes('TEAM')) teamCli(['sync']);
      }
    });

    run('team autosync on and off round-trip in team.json, status shows the switch, and init --autosync turns it on', () => {
      const configPath = path.join(HOME, '.egc', 'team.json');
      const saved = fs.readFileSync(configPath, 'utf8');
      try {
        let run = teamCli(['autosync', 'on']);
        assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
        assert.ok(run.stdout.includes('Autosync: on'), run.stdout);
        assert.strictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).autosync, true, 'on writes the switch');
        run = teamCli(['status']);
        assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
        assert.ok(run.stdout.includes('Autosync: on'), `the status shows the switch:\n${run.stdout}`);
        run = teamCli(['autosync', 'off']);
        assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
        assert.strictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).autosync, undefined, 'off removes the switch, so the file reads as before');
        run = teamCli(['status']);
        assert.ok(run.stdout.includes('Autosync: off'), run.stdout);
        run = teamCli(['autosync', 'maybe']);
        assert.strictEqual(run.status, 1, 'anything but on or off is refused');
        assert.strictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).autosync, undefined, 'a refused value changes nothing');
        run = teamCli(['init', '--backend', 'git', '--remote', REMOTE, '--key', JSON.parse(saved).teamKey, '--autosync']);
        assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
        assert.ok(run.stdout.includes('Autosync: on'), run.stdout);
        assert.strictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).autosync, true, 'init --autosync writes the switch');
      } finally {
        fs.writeFileSync(configPath, saved);
      }
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
