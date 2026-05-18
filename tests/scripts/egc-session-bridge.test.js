'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(REPO_ROOT, 'scripts', 'hooks', 'egc-session-bridge.js');
const BRIDGE_PY = path.join(REPO_ROOT, 'scripts', 'runtime', 'session_bridge.py');
const HOOKS_JSON = path.join(REPO_ROOT, 'hooks', 'hooks.json');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
}

function pythonAvailable() {
  const r = spawnSync(process.platform === 'win32' ? 'python.exe' : 'python3', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function runHook(eventName, sessionId, options) {
  const env = Object.assign({}, process.env, options.env || {});
  env.EGC_PLUGIN_ROOT = options.pluginRoot || REPO_ROOT;
  env.PROJECT_ROOT = options.workspace || REPO_ROOT;
  env.EGC_WORKSPACE_ROOT = options.workspace || env.PROJECT_ROOT;
  env.HOOK_EVENT_NAME = eventName;
  if (sessionId) env.EGC_SESSION_ID = sessionId;
  return spawnSync(process.execPath, [HOOK], {
    cwd: options.cwd || REPO_ROOT,
    env,
    input: options.stdin || '',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: process.platform === 'win32' ? 30000 : 10000,
  });
}

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

console.log('\n=== Testing egc-session-bridge ===\n');

test('hook script and python bridge are present', () => {
  assert.ok(fs.existsSync(HOOK), `Missing ${HOOK}`);
  assert.ok(fs.existsSync(BRIDGE_PY), `Missing ${BRIDGE_PY}`);
});

test('hook script passes syntax check', () => {
  const r = spawnSync(process.execPath, ['--check', HOOK], { stdio: 'pipe', encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
});

test('hooks.json registers SessionStart + SessionEnd entries', () => {
  const cfg = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  const startMatches = JSON.stringify(cfg.hooks.SessionStart || []).includes('egc-session-bridge');
  const endMatches = JSON.stringify(cfg.hooks.SessionEnd || []).includes('egc-session-bridge');
  assert.ok(startMatches, 'SessionStart missing egc-session-bridge entry');
  assert.ok(endMatches, 'SessionEnd missing egc-session-bridge entry');
});

test('hook is a no-op when EGC_SESSION_BRIDGE=off', () => {
  const tmp = createTempDir('egc-bridge-off-');
  try {
    const r = runHook('SessionStart', 'sess-off-1', {
      workspace: tmp,
      env: { EGC_SESSION_BRIDGE: 'off' },
      stdin: JSON.stringify({ hook_event_name: 'SessionStart' }),
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const log = path.join(tmp, '.sessions', 'execution_log.jsonl');
    assert.ok(!fs.existsSync(log), 'log should not be written when disabled');
  } finally {
    cleanup(tmp);
  }
});

if (!pythonAvailable()) {
  console.log('  - skipped python-dependent integration cases (python3 missing)');
} else {
  test('SessionStart emits session.sessionstart trace event', () => {
    const tmp = createTempDir('egc-bridge-start-');
    try {
      const sid = 'sess-start-' + Date.now();
      const r = runHook('SessionStart', sid, {
        workspace: tmp,
        stdin: JSON.stringify({ hook_event_name: 'SessionStart' }),
      });
      assert.strictEqual(r.status, 0, r.stderr);
      const events = readJsonLines(path.join(tmp, '.sessions', 'execution_log.jsonl'));
      const match = events.find(e => e.execution_id === sid && e.type === 'session.sessionstart');
      assert.ok(match, `expected session.sessionstart for ${sid}, got ${JSON.stringify(events)}`);
      assert.strictEqual(match.data.source, 'node-hook');
    } finally {
      cleanup(tmp);
    }
  });

  test('SessionEnd emits session.sessionend trace event', () => {
    const tmp = createTempDir('egc-bridge-end-');
    try {
      const sid = 'sess-end-' + Date.now();
      const r = runHook('SessionEnd', sid, {
        workspace: tmp,
        stdin: JSON.stringify({ hook_event_name: 'SessionEnd' }),
      });
      assert.strictEqual(r.status, 0, r.stderr);
      const events = readJsonLines(path.join(tmp, '.sessions', 'execution_log.jsonl'));
      const match = events.find(e => e.execution_id === sid && e.type === 'session.sessionend');
      assert.ok(match, `expected session.sessionend for ${sid}, got ${JSON.stringify(events)}`);
    } finally {
      cleanup(tmp);
    }
  });
}

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
