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
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

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

run('malformed stdin is treated as an anonymous session, never a crash', () => {
  const home = makeHome();
  touchWal(home, 1000000000000);
  const result = runHook(home, '{not json');
  assert.strictEqual(result.status, 0);
  assert.ok(JSON.parse(result.stdout).additionalContext.includes('[egc-mesh]'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
