/**
 * The lessons, the decisions and the working memory across two machines
 * (mcp/servers/egc-memory/src/sync/records.ts): two homes share a bare
 * remote; what one server writes, the other reads after a sync, with the
 * name of the machine it came from; a lesson reinforced on both keeps the
 * higher confidence and never doubles; an entry of working memory that
 * expired never crosses. Runs the built memory server.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { MEMORY_SERVER, startMemoryServer, initialize, callTool } = require('./fixtures/memory-server-client');
const { suiteEnv } = require('./fixtures/suite-env');
const { CLI_TIMEOUT_MS } = require('./fixtures/subprocess-timeouts');

const TEAM_CLI = path.join(__dirname, '..', 'scripts', 'team.js');
const BASE_ENV = suiteEnv(process.env);
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

if (!fs.existsSync(MEMORY_SERVER)) {
  console.log(`[SKIP] memory server build not found at ${MEMORY_SERVER}. Run 'npm run build' in mcp/servers/egc-memory first.`);
  process.exit(0);
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

function git(cwd, args) {
  return execFileSync(GIT_BIN, args, { cwd, encoding: 'utf8', env: BASE_ENV, stdio: 'pipe' }).trim();
}

function teamCli(home, args) {
  return spawnSync(process.execPath, [TEAM_CLI, ...args], { encoding: 'utf8', env: { ...BASE_ENV, HOME: home, USERPROFILE: home }, timeout: CLI_TIMEOUT_MS });
}

// A checkout of the same repository on each machine: the same origin, so
// the records name the same project key, under folders of their own.
function makeCheckout(folder) {
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(folder, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://example.com/team/app.git\n');
  return folder;
}

function makeHome(root, name, label, id) {
  const home = path.join(root, name);
  fs.mkdirSync(path.join(home, '.egc'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.egc', 'machine.json'), JSON.stringify({ id, label, createdAt: new Date().toISOString() }));
  return home;
}

function recordFiles(home, kind) {
  const dir = path.join(home, '.egc', 'team-sync', 'records', kind);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.json')) : [];
}

async function runTests() {
  console.log('\n=== Testing the records of the team sync across two machines ===\n');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-team-records-'));
  const remote = path.join(root, 'team-remote.git');
  fs.mkdirSync(remote, { recursive: true });
  git(remote, ['init', '--bare', '-q']);
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const homeA = makeHome(root, 'home-a', 'desk-a', 'a'.repeat(32));
  const homeB = makeHome(root, 'home-b', 'laptop-b', 'b'.repeat(32));
  const projectA = makeCheckout(path.join(root, 'work-a', 'app'));
  const projectB = makeCheckout(path.join(root, 'work-b', 'app'));
  const servers = [];
  const start = (home, projectDir) => {
    const server = startMemoryServer({ home, projectDir, env: { HOME: home, USERPROFILE: home } });
    servers.push(server);
    return server;
  };

  try {
    const init = teamCli(homeA, ['init', '--backend', 'git', '--remote', remote]);
    assert.strictEqual(init.status, 0, `${init.stdout}\n${init.stderr}`);
    const teamKey = JSON.parse(fs.readFileSync(path.join(homeA, '.egc', 'team.json'), 'utf8')).teamKey;
    const join = teamCli(homeB, ['init', '--backend', 'git', '--remote', remote, '--key', teamKey]);
    assert.strictEqual(join.status, 0, `${join.stdout}\n${join.stderr}`);

    const serverA = start(homeA, projectA);
    await initialize(serverA, 'writer-a');
    let lessonId = '';

    await test('the records of one machine are sealed into the team repository, the expired entry of working memory left out', async () => {
      const saved = await callTool(serverA, 'lesson_save', { content: 'Rebuild the memory server before the suite runs.', context: 'EGC tests on any machine' });
      lessonId = JSON.parse(saved).id;
      assert.ok(lessonId, saved);
      assert.ok((await callTool(serverA, 'store_decision', { context: 'records', decision: 'Ship the records with the state' })).includes('stored'));
      assert.ok((await callTool(serverA, 'working_memory_set', { project_path: projectA, key: 'branch', value: 'feat/sync-records' })).includes('stored'));
      assert.ok((await callTool(serverA, 'working_memory_set', { project_path: projectA, key: 'short', value: 'gone soon', ttl_seconds: 1 })).includes('stored'));
      await new Promise(resolve => setTimeout(resolve, 1500));
      const synced = await callTool(serverA, 'team_sync', {});
      assert.ok(/"recordsStaged":\s*3/.test(synced), `three records staged on A:\n${synced}`);
      assert.strictEqual(recordFiles(homeA, 'lesson').length, 1, 'one lesson sealed');
      assert.strictEqual(recordFiles(homeA, 'decision').length, 1, 'one decision sealed');
      assert.strictEqual(recordFiles(homeA, 'working-memory').length, 1, 'one working memory entry sealed, the expired one left out');
      const sealed = fs.readFileSync(path.join(homeA, '.egc', 'team-sync', 'records', 'lesson', `${lessonId}.json`), 'utf8');
      assert.ok(!sealed.includes('Rebuild the memory server'), 'the record travels sealed, not in the clear');
    });

    const serverB = start(homeB, projectB);
    await initialize(serverB, 'reader-b');

    await test('the other machine reads the lesson, the decision and the working memory after its sync, each with the machine it came from', async () => {
      const synced = await callTool(serverB, 'team_sync', {});
      assert.ok(/"recordsMerged":\s*3/.test(synced), `three records merged on B:\n${synced}`);
      const recalled = await callTool(serverB, 'lesson_recall', { query: 'rebuild memory server suite' });
      assert.ok(recalled.includes('Rebuild the memory server before the suite runs.'), recalled);
      assert.ok(recalled.includes('"machine": "desk-a"'), `the lesson names the machine it came from:\n${recalled}`);
      const history = await callTool(serverB, 'query_history', {});
      assert.ok(history.includes('Ship the records with the state'), history);
      assert.ok(history.includes('"machine_label": "desk-a"'), `the decision names the machine it came from:\n${history}`);
      const entry = await callTool(serverB, 'working_memory_get', { project_path: projectB, key: 'branch' });
      assert.ok(entry.includes('feat/sync-records'), `the entry of the same repository is read under the folder of B:\n${entry}`);
      const expired = await callTool(serverB, 'working_memory_get', { project_path: projectB, key: 'short' });
      assert.ok(!expired.includes('gone soon'), `the expired entry never crossed:\n${expired}`);
    });

    await test('a lesson reinforced on the other machine comes back with the higher confidence and never doubles', async () => {
      const reinforced = await callTool(serverB, 'lesson_reinforce', { id: lessonId });
      assert.ok(reinforced.includes('0.85'), reinforced);
      await callTool(serverB, 'team_sync', {});
      const synced = await callTool(serverA, 'team_sync', {});
      assert.ok(/"recordsMerged":\s*[1-9]/.test(synced), `A merged the records of B:\n${synced}`);
      const recalled = JSON.parse(await callTool(serverA, 'lesson_recall', { query: 'rebuild memory server suite' }));
      const matches = recalled.lessons.filter(lesson => lesson.id === lessonId);
      assert.strictEqual(matches.length, 1, 'one lesson, not two');
      assert.ok(Math.abs(matches[0].confidence - 0.85) < 1e-9, `the higher confidence won: ${matches[0].confidence}`);
      assert.strictEqual(recordFiles(homeA, 'lesson').length, 1, 'still one sealed record for the lesson');
    });
  } finally {
    for (const server of servers) await server.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
