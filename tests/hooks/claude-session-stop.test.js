/**
 * Subprocess tests for scripts/hooks/claude-session-stop.js save throttling.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'claude-session-stop.js');

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

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function runHook(homeDir, stdinPayload, extraEnv = {}) {
  const result = spawnSync('node', [SCRIPT], {
    input: stdinPayload,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_PROJECT_DIR: '',
      PWD: '',
      EGC_STOP_SAVE_INTERVAL_MINUTES: '',
      ...extraEnv,
    },
    timeout: 10000,
  });

  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

const STOP_INPUT = JSON.stringify({
  cwd: '/workspace/demo',
  session_id: 'session-1',
  hook_event_name: 'Stop',
});

function markerFor(homeDir) {
  return path.join(homeDir, '.egc', 'state', '.save-prompt-workspace--demo');
}

function runTests() {
  console.log('\n=== Testing claude-session-stop.js hook ===\n');

  let passed = 0;
  let failed = 0;

  if (test('first stop prompts for update_state and writes the marker', () => {
    const homeDir = createTempDir('claude-session-stop-home-');
    try {
      const result = runHook(homeDir, STOP_INPUT);

      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes('promptForAssistant'), 'prompt missing on first stop');
      assert.ok(result.stdout.includes('update_state'), 'update_state instruction missing');
      assert.ok(fs.existsSync(markerFor(homeDir)), 'marker file not written');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('a stop inside the interval does not prompt again', () => {
    const homeDir = createTempDir('claude-session-stop-home-');
    try {
      runHook(homeDir, STOP_INPUT);
      const second = runHook(homeDir, STOP_INPUT);

      assert.strictEqual(second.code, 0);
      assert.ok(!second.stdout.includes('promptForAssistant'), 'throttled stop must not prompt');
      assert.ok(second.stdout.includes('session-1'), 'input must still pass through');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('an expired marker prompts again', () => {
    const homeDir = createTempDir('claude-session-stop-home-');
    try {
      runHook(homeDir, STOP_INPUT);
      const marker = markerFor(homeDir);
      const past = new Date(Date.now() - 31 * 60 * 1000);
      fs.utimesSync(marker, past, past);

      const result = runHook(homeDir, STOP_INPUT);

      assert.ok(result.stdout.includes('promptForAssistant'), 'expired marker must prompt again');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('interval of 0 prompts on every stop', () => {
    const homeDir = createTempDir('claude-session-stop-home-');
    try {
      runHook(homeDir, STOP_INPUT, { EGC_STOP_SAVE_INTERVAL_MINUTES: '0' });
      const second = runHook(homeDir, STOP_INPUT, { EGC_STOP_SAVE_INTERVAL_MINUTES: '0' });

      assert.ok(second.stdout.includes('promptForAssistant'), 'interval 0 must always prompt');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('projects throttle independently', () => {
    const homeDir = createTempDir('claude-session-stop-home-');
    try {
      runHook(homeDir, STOP_INPUT);
      const other = runHook(homeDir, JSON.stringify({ cwd: '/workspace/other', session_id: 's2' }));

      assert.ok(other.stdout.includes('promptForAssistant'), 'a different project must still prompt');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('exits silently on invalid stdin', () => {
    const homeDir = createTempDir('claude-session-stop-home-');
    try {
      const result = runHook(homeDir, 'not json');

      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
