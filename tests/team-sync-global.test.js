/**
 * The user-wide memory in the Team Brain sync: what update_state writes with
 * scope "global" on one machine is what get_state appends on the other after
 * a sync, the two copies merge section by section, the copy on the remote is
 * a sealed envelope, and a file of the state trees that is not a state
 * document (a lock beside a document) never leaves the machine. Drives the
 * `egc team` CLI and the built memory server in two homes against one bare
 * remote.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { removeDirWithRetries } = require('./fixtures/remove-dir');
const { FULL_INSTALL_TIMEOUT_MS } = require('./fixtures/subprocess-timeouts');
const { suiteEnv } = require('./fixtures/suite-env');

const ROOT = path.join(__dirname, '..');
const TEAM_CLI = path.join(ROOT, 'scripts', 'team.js');
const MEMORY_SERVER = path.join(ROOT, 'mcp', 'servers', 'egc-memory', 'build', 'index.js');
const REMOTE_URL = 'https://github.com/Owner/Repo.git';
const BASE_ENV = suiteEnv(process.env);
// Fixed git locations before a PATH lookup.
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

function git(cwd, args) {
  return execFileSync(GIT_BIN, args, { cwd, env: BASE_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeCheckout(root, relativePath) {
  const repo = path.join(root, relativePath);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'test repo\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['-c', 'user.email=test@test', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial']);
  git(repo, ['checkout', '-q', '-B', 'main']);
  git(repo, ['remote', 'add', 'origin', REMOTE_URL]);
  return repo;
}

function envFor(home) {
  return { ...BASE_ENV, HOME: home, USERPROFILE: home };
}

function cli(env, args) {
  const result = spawnSync(process.execPath, [TEAM_CLI, ...args], { encoding: 'utf8', env, timeout: FULL_INSTALL_TIMEOUT_MS });
  assert.strictEqual(result.status, 0, `egc team ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function server(env, name, args) {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'team-global-test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ];
  const result = spawnSync(process.execPath, [MEMORY_SERVER], { input: messages.map(m => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8', env, timeout: FULL_INSTALL_TIMEOUT_MS });
  const answer = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(message => message.id === 2);
  assert.ok(answer && answer.result, `${name} got no answer:\n${result.stdout}\n${result.stderr}`);
  return answer.result.content[0].text;
}

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)));
}

if (!fs.existsSync(MEMORY_SERVER)) {
  console.log(`[SKIP] memory server build not found under ${path.dirname(MEMORY_SERVER)}. Run 'npm run build' in mcp/servers/egc-memory first.`);
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-team-global-'));
const homeA = path.join(dir, 'home-a');
const homeB = path.join(dir, 'home-b');
const remote = path.join(dir, 'team-remote');
const envA = envFor(homeA);
const envB = envFor(homeB);

try {
  console.log('\n=== Testing the global memory in the team sync ===\n');
  fs.mkdirSync(remote, { recursive: true });
  git(remote, ['init', '--bare', '-q']);
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const projectA = makeCheckout(homeA, path.join('work', 'app'));
  const projectB = makeCheckout(homeB, path.join('code', 'app-clone'));

  test('a preference written with scope global on one machine is in the state the other machine restores after a sync', () => {
    cli(envA, ['init', '--backend', 'git', '--remote', remote]);
    const key = JSON.parse(fs.readFileSync(path.join(homeA, '.egc', 'team.json'), 'utf8')).teamKey;
    assert.ok(server(envA, 'update_state', { project_path: projectA, context: 'The app.' }).includes('Project memory updated'));
    server(envA, 'update_state', { project_path: projectA, scope: 'global', preferences: ['global preference from machine A'] });
    cli(envA, ['sync']);
    cli(envB, ['init', '--backend', 'git', '--remote', remote, '--key', key]);
    cli(envB, ['sync']);
    const stateOnB = server(envB, 'get_state', { project_path: projectB });
    assert.ok(stateOnB.includes('Global Memory'), `the global appendix is there:\n${stateOnB}`);
    assert.ok(stateOnB.includes('global preference from machine A'), `the preference of machine A is there:\n${stateOnB}`);
  });

  test('the global memory travels sealed: the copy in the shared repository does not show its text', () => {
    const sealed = path.join(homeA, '.egc', 'team-sync', 'global', 'state.md');
    assert.ok(fs.existsSync(sealed), 'the global document is in the shared tree');
    assert.ok(!fs.readFileSync(sealed, 'utf8').includes('global preference from machine A'), 'no plaintext on the remote');
  });

  test('the two copies of the global memory merge section by section, so a preference written on each machine survives on both', () => {
    server(envB, 'update_state', { project_path: projectB, scope: 'global', preferences: ['global preference from machine B'] });
    server(envA, 'update_state', { project_path: projectA, scope: 'global', preferences: ['another global preference from machine A'] });
    cli(envB, ['sync']);
    cli(envA, ['sync']);
    cli(envB, ['sync']);
    for (const [label, env, project] of [['A', envA, projectA], ['B', envB, projectB]]) {
      const state = server(env, 'get_state', { project_path: project });
      for (const preference of ['global preference from machine A', 'global preference from machine B', 'another global preference from machine A']) {
        assert.ok(state.includes(preference), `${preference} is on machine ${label}:\n${state}`);
      }
    }
  });

  test('a file of the state trees that is not a state document stays on its machine', () => {
    const stateDirs = fs.readdirSync(path.join(homeA, '.egc', 'state'), { withFileTypes: true }).filter(entry => entry.isDirectory());
    assert.ok(stateDirs.length > 0, 'machine A has a project state directory');
    fs.writeFileSync(path.join(homeA, '.egc', 'state', stateDirs[0].name, 'main.md.merge.lock'), '4242\n');
    fs.writeFileSync(path.join(homeA, '.egc', 'global', 'state.md.merge.lock'), '4242\n');
    server(envA, 'update_state', { project_path: projectA, decisions: [{ what: 'a decision that makes the push happen', why: 'test' }] });
    cli(envA, ['sync']);
    const shared = [
      ...filesUnder(path.join(homeA, '.egc', 'team-sync', 'state')),
      ...filesUnder(path.join(homeA, '.egc', 'team-sync', 'global')),
    ];
    assert.ok(shared.length > 0, 'the shared tree holds the documents');
    assert.deepStrictEqual(shared.filter(file => !file.endsWith('.md')), [], `only state documents are shared: ${shared.join(', ')}`);
  });

  test('a sync with nothing new adds no commit to the remote', () => {
    cli(envA, ['sync']);
    const before = git(remote, ['rev-list', '--count', 'main']);
    cli(envA, ['sync']);
    cli(envB, ['sync']);
    cli(envB, ['sync']);
    assert.strictEqual(git(remote, ['rev-list', '--count', 'main']), before, 'the history of the remote did not grow');
  });
} finally {
  removeDirWithRetries(dir);
}

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
