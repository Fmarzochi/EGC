/**
 * Wrote, told (mcp/servers/egc-memory/src/memory-notify.ts): a write of
 * memory by one server reaches the other sessions of the machine as a
 * memory:changed event on the bus, and schedules a sync with the team
 * remote, several writes becoming one; a sync still pending when the server
 * stops runs before it closes. Runs against the built memory server, two
 * homes and a bare remote.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { MEMORY_SERVER, startMemoryServer, initialize, callTool } = require('./fixtures/memory-server-client');
const { suiteEnv } = require('./fixtures/suite-env');

if (!fs.existsSync(MEMORY_SERVER)) {
  console.log(`[SKIP] memory server build not found under ${path.dirname(MEMORY_SERVER)}. Run 'npm run build' in mcp/servers/egc-memory first.`);
  process.exit(0);
}

const TEAM_CLI = path.join(__dirname, '..', 'scripts', 'team.js');
const STEP_TIMEOUT_MS = 10000;
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

async function until(check, what, budgetMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function git(cwd, args) {
  return execFileSync(GIT_BIN, args, { cwd, env: BASE_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function teamCli(home, args) {
  return execFileSync(process.execPath, [TEAM_CLI, ...args], { encoding: 'utf8', env: { ...BASE_ENV, HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'pipe'] });
}

// A checkout with an origin, so the project has a repository identity and
// the server resolves a branch for it.
function makeCheckout(folder) {
  fs.mkdirSync(folder, { recursive: true });
  git(folder, ['init', '-q', '-b', 'main']);
  git(folder, ['remote', 'add', 'origin', 'https://example.com/team/app.git']);
  return folder;
}

function remoteHead(remote) {
  try {
    return git(remote, ['rev-parse', 'main']);
  } catch {
    return null;
  }
}

function remoteCommits(remote) {
  try {
    return Number(git(remote, ['rev-list', '--count', 'main'])) || 0;
  } catch {
    return 0;
  }
}

function parseEvents(text) {
  return [...text.matchAll(/^- #(\d+) \[([^\]]+)\] from (\S+)/gm)].map(match => ({ id: Number(match[1]), kind: match[2], from: match[3] }));
}

async function runTests() {
  console.log('\n=== Testing the memory change notices and the scheduled sync ===\n');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-memory-notify-'));
  const homeA = path.join(root, 'home-a');
  const project = makeCheckout(path.join(root, 'work', 'app'));
  const servers = [];
  const start = (home, env = {}) => {
    const server = startMemoryServer({ home, projectDir: project, env });
    servers.push(server);
    return server;
  };

  try {
    const writer = start(homeA);
    const reader = start(homeA);
    await initialize(writer, 'writer');
    await initialize(reader, 'reader');

    await test('a write of memory on one server is told to the other sessions of the machine as a memory:changed event', async () => {
      await callTool(reader, 'session_announce', { project_path: project, territory: 'reading' });
      await callTool(reader, 'session_events', { project_path: project });
      assert.ok((await callTool(writer, 'update_state', { project_path: project, context: 'The app.', decisions: [{ what: 'x', why: 'y' }] })).includes('Project memory updated'));
      await callTool(writer, 'store_decision', { context: 'ctx', decision: 'keep it' });
      await callTool(writer, 'lesson_save', { content: 'a lesson', context: 'testing' });
      await callTool(writer, 'working_memory_set', { project_path: project, key: 'k', value: 'v' });
      let text = '';
      await until(async () => {
        text = await callTool(reader, 'session_events', { project_path: project, peek: true });
        return parseEvents(text).filter(event => event.kind === 'memory:changed').length >= 4;
      }, 'the four notices to reach the reader');
      const notices = parseEvents(text).filter(event => event.kind === 'memory:changed');
      assert.ok(notices.every(event => event.from.startsWith('bus-')), `the notices come from the writing server: ${text}`);
      for (const kind of ['"kind":"state"', '"kind":"decision"', '"kind":"lesson"', '"kind":"working-memory"']) {
        assert.ok(text.includes(kind), `a notice of ${kind} is there:\n${text}`);
      }
      assert.ok(text.includes('read get_state again'), 'the notice carries the hint');
      assert.ok(text.includes('"branch":"main"'), 'the state notice names the branch');
    });

    await test('a write with scope global is told to every session, with no project', async () => {
      await callTool(writer, 'update_state', { project_path: project, scope: 'global', preferences: ['short answers'] });
      let text = '';
      await until(async () => {
        text = await callTool(reader, 'session_events', { project_path: project });
        return text.includes('"scope":"global"');
      }, 'the global notice to reach the reader');
    });

    await test('the notices of one server are capped on the bus, the newest kept', async () => {
      for (let index = 0; index < 25; index += 1) {
        await callTool(writer, 'working_memory_set', { project_path: project, key: `k${index}`, value: 'v' });
      }
      const text = await callTool(reader, 'session_events', { project_path: project });
      const ids = parseEvents(text).filter(event => event.kind === 'memory:changed').map(event => event.id);
      assert.strictEqual(ids.length, 20, `twenty-five writes against a cap of twenty leave exactly twenty, got ${ids.length}`);
      // The ids of the bus grow with every event: twenty survivors spanning
      // nineteen are the twenty newest, with none of the older ones kept.
      assert.strictEqual(Math.max(...ids) - Math.min(...ids), 19, `the twenty kept are the newest, consecutive ids: ${ids.join(', ')}`);
    });

    await writer.stop();
    await reader.stop();

    await test('with a team remote, a write schedules a sync and several writes become one', async () => {
      const remote = path.join(root, 'team-remote');
      fs.mkdirSync(remote, { recursive: true });
      git(remote, ['init', '--bare', '-q']);
      git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
      teamCli(homeA, ['init', '--backend', 'git', '--remote', remote]);
      const before = remoteHead(remote);
      const commitsBefore = remoteCommits(remote);
      // Two seconds between the first write and the sync: room for the
      // second write on a slow runner, so the two become one sync.
      const server = start(homeA, { EGC_MEMORY_PUSH_DELAY_MS: '2000' });
      await initialize(server, 'pusher');
      await callTool(server, 'update_state', { project_path: project, context: 'Pushed by the write.' });
      await callTool(server, 'update_state', { project_path: project, decisions: [{ what: 'second write', why: 'joins the first' }] });
      await until(() => remoteHead(remote) !== null && remoteHead(remote) !== before, 'the remote to receive the sync scheduled by the writes');
      await new Promise(resolve => setTimeout(resolve, 2500));
      assert.strictEqual(remoteCommits(remote) - commitsBefore, 1, 'two writes within the delay became one sync, one commit on the remote, and nothing syncs again without a write');
      await server.stop();
    });

    await test('with the sync around the session off, a write is told and nothing syncs by itself', async () => {
      const remote = path.join(root, 'team-remote');
      teamCli(homeA, ['autosync', 'off']);
      try {
        const before = remoteHead(remote);
        const server = start(homeA, { EGC_MEMORY_PUSH_DELAY_MS: '300' });
        await initialize(server, 'quiet-writer');
        await callTool(server, 'update_state', { project_path: project, context: 'Written with the autosync off.' });
        await new Promise(resolve => setTimeout(resolve, 1500));
        assert.strictEqual(remoteHead(remote), before, 'the remote did not move: the switch is off');
        await server.stop();
        assert.strictEqual(remoteHead(remote), before, 'nor did the stop sync it');
      } finally {
        teamCli(homeA, ['autosync', 'on']);
      }
    });

    await test('a sync still pending when the server stops runs before it closes', async () => {
      const remote = path.join(root, 'team-remote');
      const before = remoteHead(remote);
      const server = start(homeA, { EGC_MEMORY_PUSH_DELAY_MS: '60000' });
      await initialize(server, 'late-writer');
      await callTool(server, 'update_state', { project_path: project, context: 'Written just before the stop.' });
      assert.strictEqual(remoteHead(remote), before, 'nothing has synced yet: the delay is a minute');
      await server.stop();
      assert.notStrictEqual(remoteHead(remote), before, 'the stop ran the pending sync');
    });
  } finally {
    for (const server of servers) await server.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
