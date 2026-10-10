'use strict';
/**
 * Tests for scripts/hooks/antigravity-mesh-notice-adapter.js
 *
 * Antigravity's PreInvocation contract (antigravity.google/docs/hooks): a
 * {conversationId, workspacePaths, invocationNum, ...} event on stdin and an
 * {injectSteps} object on stdout. Checked here: an empty object when there
 * is nothing to say, one ephemeral message the first time the bus store
 * moved for a conversation, a cursor per conversation, and exit 0 always,
 * unreadable stdin included.
 *
 * Run with: node tests/hooks/antigravity-mesh-notice-adapter.test.js
 */
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ADAPTER = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'antigravity-mesh-notice-adapter.js');
const { buildInjection } = require(ADAPTER);
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-antigravity-mesh-'));
}

function runAdapter(home, payload) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const options = { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS };
  if (payload === null) options.stdio = ['ignore', 'pipe', 'pipe'];
  else options.input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [ADAPTER], options);
  return { status: result.status, output: JSON.parse(result.stdout || 'null'), stderr: result.stderr || '' };
}

function touchWal(home, epochMs) {
  const dir = path.join(home, '.egc', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const wal = path.join(dir, 'state.db-wal');
  fs.appendFileSync(wal, 'x');
  const t = new Date(epochMs);
  fs.utimesSync(wal, t, t);
}

function event(conversationId) {
  return { conversationId, workspacePaths: ['/workspace/app'], invocationNum: 0, initialNumSteps: 0 };
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

console.log('\n=== Testing antigravity-mesh-notice-adapter ===\n');

run('answers an empty object with exit 0 when there is no stdin and no bus store', () => {
  const home = makeHome();
  const result = runAdapter(home, null);
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.output, {});
});

run('injects one ephemeral message the first time the store moved for a conversation, then stays quiet', () => {
  const home = makeHome();
  touchWal(home, Date.UTC(2026, 9, 10, 1, 0, 0));
  const first = runAdapter(home, event('conv-1'));
  assert.strictEqual(first.status, 0);
  assert.strictEqual(first.output.injectSteps.length, 1);
  assert.match(first.output.injectSteps[0].ephemeralMessage, /^\[egc-mesh\] The shared session bus moved/);
  assert.deepStrictEqual(Object.keys(first.output.injectSteps[0]), ['ephemeralMessage']);
  const second = runAdapter(home, event('conv-1'));
  assert.deepStrictEqual(second.output, {}, 'nothing moved since this conversation last looked');
  touchWal(home, Date.UTC(2026, 9, 10, 1, 5, 0));
  assert.strictEqual(runAdapter(home, event('conv-1')).output.injectSteps.length, 1, 'a later move is announced again');
});

run('each conversation keeps its own cursor', () => {
  const home = makeHome();
  touchWal(home, Date.UTC(2026, 9, 10, 1, 0, 0));
  runAdapter(home, event('conv-1'));
  const other = runAdapter(home, event('conv-2'));
  assert.strictEqual(other.output.injectSteps.length, 1, 'the second conversation has not looked yet');
});

run('unreadable stdin is an empty object with exit 0, never a broken turn', () => {
  const home = makeHome();
  touchWal(home, Date.UTC(2026, 9, 10, 1, 0, 0));
  const result = runAdapter(home, 'not json');
  assert.strictEqual(result.status, 0);
  assert.ok(result.output && typeof result.output === 'object', 'a JSON object is printed');
});

run('buildInjection shapes the notice as one ephemeral message step and nothing when quiet', () => {
  const home = makeHome();
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    assert.deepStrictEqual(buildInjection(event('conv-9')), {});
    touchWal(home, Date.UTC(2026, 9, 10, 1, 0, 0));
    const injection = buildInjection(event('conv-9'));
    assert.deepStrictEqual(Object.keys(injection), ['injectSteps']);
    assert.strictEqual(injection.injectSteps.length, 1);
    assert.match(injection.injectSteps[0].ephemeralMessage, /session_events/);
  } finally {
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedProfile;
  }
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
