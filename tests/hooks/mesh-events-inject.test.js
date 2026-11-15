'use strict';
/**
 * Tests for scripts/hooks/mesh-events-inject.js
 *
 * The mesh wake-signal hook (design #1251, layer C2). Contract under test:
 * silence when there is no store or nothing moved, a strict-JSON notice the
 * first time the store moved for a given session (dual-field shape so Claude
 * Code, Gemini CLI, and Goose all read it), per-session cursors, mtime-based
 * change detection under explicit clock control, path-safe cache naming for
 * hostile session ids, and exit 0 always.
 *
 * Run with: node tests/hooks/mesh-events-inject.test.js
 */
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'mesh-events-inject.js');
const { markKey } = require('../../scripts/lib/team-autosync-turn');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');
const AUTOSYNC = path.join(__dirname, '..', '..', 'scripts', 'lib', 'team-autosync.js');

// Whether the hook under test will find a built memory server: resolved the
// way the hook resolves it, in a child under the same home, so a server
// installed in the developer's real home never makes the answer differ from
// the child's. A lane without the build (the yarn lanes of the CI) still
// runs these tests: there the first sync is denied, the session stays
// unmarked, and the next prompt tries again.
function serverBuiltFor(home) {
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(require(process.argv[1]).memoryServerScript() !== null))', AUTOSYNC], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
  });
  return probe.stdout.trim() === 'true';
}

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-mesh-hook-'));
}

function runHook(home, payload) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const options = { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS };
  if (payload === null) options.stdio = ['ignore', 'pipe', 'pipe'];
  else options.input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return spawnSync(process.execPath, [HOOK], options);
}

function touchWal(home, epochMs) {
  const dir = path.join(home, '.egc', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const wal = path.join(dir, 'state.db-wal');
  fs.appendFileSync(wal, 'x');
  const t = new Date(epochMs);
  fs.utimesSync(wal, t, t);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
const run = (name, fn) => { test(name, fn) ? passed++ : failed++; };

console.log('\n=== Testing mesh-events-inject hook ===\n');

run('exits 0 silently with no stdin and no store', () => {
  const home = makeHome();
  const result = runHook(home, null);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
});

run('stays silent when the machine has no bus store', () => {
  const home = makeHome();
  const result = runHook(home, { session_id: 'tab-a' });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
});

run('emits the dual-field JSON notice the first time the store moved', () => {
  const home = makeHome();
  touchWal(home, 1000000000000);
  const result = runHook(home, { session_id: 'tab-a' });
  assert.strictEqual(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.additionalContext.includes('[egc-mesh]'), 'top-level additionalContext carries the notice');
  assert.ok(
    parsed.additionalContext.includes('scheduled wakeups'),
    'the notice must reach loop turns too, not only user-typed prompts (#1293)'
  );
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.strictEqual(parsed.hookSpecificOutput.additionalContext, parsed.additionalContext, 'both consumers read the same text');
  assert.strictEqual(result.stdout.trim(), result.stdout, 'strict JSON only, no stray output');
});

run('--format=text emits the bare notice for raw-stdout hosts (Trae, Amp bridge)', () => {
  const home = makeHome();
  touchWal(home, 1000000000000);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const result = spawnSync(process.execPath, [HOOK, '--format=text'], {
    env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, input: JSON.stringify({ session_id: 'tab-a' }),
  });
  assert.strictEqual(result.status, 0);
  assert.ok(result.stdout.startsWith('[egc-mesh]'), 'plain notice, no JSON wrapper');
  assert.throws(() => JSON.parse(result.stdout), 'text mode must not be valid JSON');
});

run('stays silent on the next prompt when nothing moved', () => {
  const home = makeHome();
  touchWal(home, 1000000000000);
  runHook(home, { session_id: 'tab-a' });
  const second = runHook(home, { session_id: 'tab-a' });
  assert.strictEqual(second.status, 0);
  assert.strictEqual(second.stdout, '');
});

run('notices again when the store moves after the last look', () => {
  const home = makeHome();
  touchWal(home, 1000000000000);
  runHook(home, { session_id: 'tab-a' });
  touchWal(home, 1000000005000);
  const third = runHook(home, { session_id: 'tab-a' });
  assert.ok(JSON.parse(third.stdout).additionalContext.includes('[egc-mesh]'));
});

run('cursors are per session: a second tab gets its own first notice', () => {
  const home = makeHome();
  touchWal(home, 1000000000000);
  runHook(home, { session_id: 'tab-a' });
  const other = runHook(home, { session_id: 'tab-b' });
  assert.ok(JSON.parse(other.stdout).additionalContext.includes('[egc-mesh]'));
});

run('a hostile session id cannot escape the cache directory', () => {
  const home = makeHome();
  touchWal(home, 1000000000000);
  const result = runHook(home, { session_id: '../../../escape/attempt' });
  assert.strictEqual(result.status, 0);
  const meshDir = path.join(home, '.egc', 'mesh');
  const entries = fs.readdirSync(meshDir);
  assert.strictEqual(entries.length, 1, 'exactly one cache file, inside the mesh dir');
  assert.ok(/^notice-[A-Za-z0-9_-]+\.json$/.test(entries[0]), `sanitized name, got ${entries[0]}`);
  assert.ok(!fs.existsSync(path.join(home, 'escape')), 'no traversal outside the cache dir');
});

run('a payload larger than a pipe buffer is read whole and still keys the cursor by its session', () => {
  const home = makeHome();
  touchWal(home, 1000000000000);
  const result = runHook(home, { session_id: 'tab-big', filler: 'x'.repeat(200000) });
  assert.strictEqual(result.status, 0);
  assert.ok(JSON.parse(result.stdout).additionalContext.includes('[egc-mesh]'));
  assert.ok(fs.existsSync(path.join(home, '.egc', 'mesh', 'notice-tab-big.json')), 'the cursor file carries the session id from the payload');
});

run('malformed stdin is treated as an anonymous session, never a crash', () => {
  const home = makeHome();
  touchWal(home, 1000000000000);
  const result = runHook(home, '{not json');
  assert.strictEqual(result.status, 0);
  assert.ok(JSON.parse(result.stdout).additionalContext.includes('[egc-mesh]'));
});

run('--team-sync without a team leaves the notice as it is and syncs nothing', () => {
  const home = makeHome();
  touchWal(home, 1000000000000);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const result = spawnSync(process.execPath, [HOOK, '--team-sync'], { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, input: JSON.stringify({ session_id: 'turn-1' }) });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).additionalContext.includes('[egc-mesh]'));
  assert.ok(!fs.existsSync(path.join(home, '.egc', 'logs', 'team-autosync.log')), 'no team: no sync log');
  assert.ok(!fs.existsSync(path.join(home, '.egc', 'mesh', 'team-pull-turn-1.json')), 'no team: no pull mark');
});

run('--team-sync with a team syncs whole at the first turn of a session, stays quiet while nothing changed, and pushes at the turn after a document changed', () => {
  const home = makeHome();
  touchWal(home, 1000000000000);
  fs.mkdirSync(path.join(home, '.egc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.egc', 'team.json'), JSON.stringify({ backend: 'git', remote: path.join(home, 'no-such-remote.git'), branch: 'main', teamKey: 'ab'.repeat(32), autosync: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const prompt = () => spawnSync(process.execPath, [HOOK, '--team-sync'], { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, input: JSON.stringify({ session_id: 'turn-2' }) });
  const logPath = path.join(home, '.egc', 'logs', 'team-autosync.log');
  const lines = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []);
  const first = prompt();
  assert.strictEqual(first.status, 0, first.stderr);
  assert.strictEqual(lines().length, 1, `one run is logged:\n${lines().join('\n')}`);
  const mark = path.join(home, '.egc', 'mesh', `team-pull-${markKey('turn-2')}.json`);
  if (!serverBuiltFor(home)) {
    assert.match(lines()[0], /turn-start: skipped: the memory server/);
    assert.ok(!fs.existsSync(mark), 'a denied first sync leaves no mark');
    const again = prompt();
    assert.strictEqual(again.status, 0, again.stderr);
    assert.strictEqual(lines().length, 2, 'the next prompt tries the first sync again');
    return;
  }
  assert.match(lines()[0], /turn-start: (ok|failed): /, 'the memory server of this checkout ran the sync against a remote that does not exist');
  assert.ok(fs.existsSync(mark), 'the session is marked as synced, under a hash of its id');
  const quiet = prompt();
  assert.strictEqual(quiet.status, 0, quiet.stderr);
  assert.strictEqual(lines().length, 1, 'nothing changed since: the next turn runs no sync');
  fs.mkdirSync(path.join(home, '.egc', 'state', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(home, '.egc', 'state', 'proj', 'main.md'), '# state\n');
  const changed = prompt();
  assert.strictEqual(changed.status, 0, changed.stderr);
  assert.strictEqual(lines().length, 2, `a changed document makes the next turn push:\n${lines().join('\n')}`);
  assert.match(lines()[1], /turn: (ok|failed): /);
});

run('the Codex adapter prints the dual-field notice, runs the Team Brain sync of the first turn, and prints nothing when quiet', () => {
  const adapter = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'codex-mesh-notice-adapter.js');
  const home = makeHome();
  touchWal(home, 1000000000000);
  fs.mkdirSync(path.join(home, '.egc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.egc', 'team.json'), JSON.stringify({ backend: 'git', remote: path.join(home, 'no-such-remote.git'), branch: 'main', teamKey: 'ab'.repeat(32), autosync: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const loud = spawnSync(process.execPath, [adapter], { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, input: JSON.stringify({ session_id: 'codex-1' }) });
  assert.strictEqual(loud.status, 0, loud.stderr);
  const answer = JSON.parse(loud.stdout);
  assert.ok(answer.additionalContext.includes('[egc-mesh]'), 'the top-level field Codex reads');
  assert.strictEqual(answer.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(answer.hookSpecificOutput.additionalContext.includes('[egc-mesh]'), 'the nested field too');
  const logPath = path.join(home, '.egc', 'logs', 'team-autosync.log');
  assert.ok(fs.existsSync(logPath), 'the adapter turned the Team Brain sync on');
  const codexMark = path.join(home, '.egc', 'mesh', `team-pull-${markKey('codex-1')}.json`);
  if (serverBuiltFor(home)) {
    assert.match(fs.readFileSync(logPath, 'utf8'), /turn-start: (ok|failed): /);
    assert.ok(fs.existsSync(codexMark), 'the session is marked as synced');
  } else {
    assert.match(fs.readFileSync(logPath, 'utf8'), /turn-start: skipped: the memory server/);
    assert.ok(!fs.existsSync(codexMark), 'a denied first sync leaves no mark');
  }
  const quiet = spawnSync(process.execPath, [adapter], { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, input: JSON.stringify({ session_id: 'codex-1' }) });
  assert.strictEqual(quiet.status, 0, quiet.stderr);
  assert.strictEqual(quiet.stdout, '', 'the second prompt of the session, nothing new: silence');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
