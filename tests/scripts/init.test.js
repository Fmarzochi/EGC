/**
 * Tests for the tail of `egc init`: a sandboxed home and project, no TTY,
 * so the run must print the compact install check instead of the full
 * doctor report, the memory and token crusher status lines, the headless
 * dashboard line, and end on the completion line.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const INIT = path.join(__dirname, '..', '..', 'scripts', 'init.js');

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

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// A cold init bootstraps the cognitive protocol and the state store, so it
// gets the long budget the other installer tests use on Windows runners.
function runInit(args, { homeDir, projectDir }) {
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, CI: '1' };
  delete env.EGC_DIR;
  return spawnSync(process.execPath, [INIT, ...args], {
    cwd: projectDir,
    env,
    encoding: 'utf8',
    timeout: process.platform === 'win32' ? 180000 : 90000,
  });
}

function lastNonEmptyLine(text) {
  const lines = text.split('\n').map(line => line.trimEnd()).filter(Boolean);
  return lines[lines.length - 1] || '';
}

test('a sandboxed init prints the compact check, the status lines and ends on the completion line', () => {
  const homeDir = makeTempDir('egc-init-home-');
  const projectDir = makeTempDir('egc-init-project-');
  try {
    const result = runInit(['--yes'], { homeDir, projectDir });
    assert.strictEqual(result.status, 0, `init exited ${result.status}\n${result.stderr}\n${result.stdout}`);
    const out = result.stdout;

    assert.ok(!out.includes('Doctor report:'), 'the full doctor report must not be inherited into the init output');
    assert.ok(!out.includes('Summary: checked='), 'the doctor summary line belongs to egc doctor, not init');
    assert.ok(out.includes('checking the install (egc doctor)...'), 'the check is announced once without a TTY');
    assert.ok(out.includes('install check'), 'the compact install check line is printed');
    assert.ok(out.includes('no managed target profile installed yet'), 'a bare install is reported as such');
    assert.ok(out.includes('egc install --target <target> --profile full'), 'the full-profile command is printed');

    assert.ok(out.includes('  memory  '), 'the memory status line is printed');
    assert.ok(/state store (ready|not found)/.test(out), 'the memory line reports the state store');
    assert.ok(/token crusher/.test(out), 'the token crusher status line is printed');
    assert.ok(!out.includes('Token Crusher engaged'), 'the old slogan is gone');
    assert.ok(!out.includes('compressed up to'), 'no percentage claim');
    assert.ok(!out.includes('Route heavy commands'), 'the closing tip is gone');

    assert.ok(out.includes("Dashboard not started (headless environment). Run 'egc dashboard' to start it."), 'headless runs print the same dashboard line as the other installers');
    assert.ok(out.includes('Installation complete.'), 'the completion line is printed');
    assert.ok(lastNonEmptyLine(out).trim().startsWith('Installation complete.'), `the completion line must be the last line, got: ${lastNonEmptyLine(out)}`);

    assert.ok(!out.includes('\r'), 'no carriage return without a TTY');
    assert.ok(!out.includes('\x1b['), 'no escape sequence without a TTY');
  } finally {
    cleanup(homeDir);
    cleanup(projectDir);
  }
});

test('a dry run announces the check and completes without touching the dashboard', () => {
  const homeDir = makeTempDir('egc-init-home-');
  const projectDir = makeTempDir('egc-init-project-');
  try {
    const result = runInit(['--dry-run'], { homeDir, projectDir });
    assert.strictEqual(result.status, 0, `init exited ${result.status}\n${result.stderr}`);
    assert.ok(result.stdout.includes('[dry-run] would run: egc doctor'));
    assert.ok(result.stdout.includes('Installation complete.'));
    assert.ok(!result.stdout.includes('Dashboard'), 'a dry run never launches or mentions the dashboard');
    assert.ok(!result.stdout.includes('Doctor report:'));
  } finally {
    cleanup(homeDir);
    cleanup(projectDir);
  }
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
