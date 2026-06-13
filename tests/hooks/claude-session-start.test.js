/**
 * Subprocess tests for scripts/hooks/claude-session-start.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'claude-session-start.js');

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

function writeStateFile(homeDir, slug, content) {
  const stateDir = path.join(homeDir, '.egc', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, `${slug}.md`), content);
}

function runTests() {
  console.log('\n=== Testing claude-session-start.js hook ===\n');

  let passed = 0;
  let failed = 0;

  if (test('prints the state file for the cwd received on stdin', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      writeStateFile(homeDir, 'workspace--demo', '# Project State\n- resume feature X\n');

      const result = runHook(
        homeDir,
        JSON.stringify({ cwd: '/workspace/demo', hook_event_name: 'SessionStart' })
      );

      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes('EGC persistent memory'));
      assert.ok(result.stdout.includes('resume feature X'));
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('uses the same slug sanitization as the egc-memory server', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      writeStateFile(homeDir, 'My_Projects--app_v2_0', 'sanitized slug state\n');

      const result = runHook(
        homeDir,
        JSON.stringify({ cwd: '/home/user/My Projects/app v2.0' })
      );

      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes('sanitized slug state'));
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('exits silently with code 0 when no state file exists', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      const result = runHook(homeDir, JSON.stringify({ cwd: '/workspace/empty' }));

      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('exits silently with code 0 when the state file is blank', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      writeStateFile(homeDir, 'workspace--blank', '   \n\n');

      const result = runHook(homeDir, JSON.stringify({ cwd: '/workspace/blank' }));

      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('tolerates invalid stdin and falls back to environment paths', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      writeStateFile(homeDir, 'env--project', 'state from env fallback\n');

      const result = runHook(homeDir, 'not json at all', {
        CLAUDE_PROJECT_DIR: '/env/project',
      });

      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes('state from env fallback'));
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
