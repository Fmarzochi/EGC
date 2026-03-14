/**
 * Tests for scripts/session-inspect.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'session-inspect.js');

function run(args = [], options = {}) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        ...(options.env || {})
      }
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status || 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing session-inspect.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('shows usage when no target is provided', () => {
    const result = run();
    assert.strictEqual(result.code, 1);
    assert.ok(result.stdout.includes('Usage:'));
  })) passed++; else failed++;

  if (test('prints canonical JSON for claude history targets', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-inspect-home-'));
    const sessionsDir = path.join(homeDir, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    try {
      fs.writeFileSync(
        path.join(sessionsDir, '2026-03-13-a1b2c3d4-session.tmp'),
        '# Inspect Session\n\n**Branch:** feat/session-inspect\n'
      );

      const result = run(['claude:latest'], {
        env: { HOME: homeDir }
      });

      assert.strictEqual(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.strictEqual(payload.adapterId, 'claude-history');
      assert.strictEqual(payload.session.kind, 'history');
      assert.strictEqual(payload.workers[0].branch, 'feat/session-inspect');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('writes snapshot JSON to disk when --write is provided', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-inspect-home-'));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-inspect-out-'));
    const sessionsDir = path.join(homeDir, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const outputPath = path.join(outputDir, 'snapshot.json');

    try {
      fs.writeFileSync(
        path.join(sessionsDir, '2026-03-13-a1b2c3d4-session.tmp'),
        '# Inspect Session\n\n**Branch:** feat/session-inspect\n'
      );

      const result = run(['claude:latest', '--write', outputPath], {
        env: { HOME: homeDir }
      });

      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(fs.existsSync(outputPath));
      const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      assert.strictEqual(written.adapterId, 'claude-history');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
