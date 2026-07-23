/**
 * Tests for install.sh wrapper delegation
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'install.sh');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function run(args = [], options = {}) {
  const env = {
    ...process.env,
    HOME: options.homeDir || process.env.HOME,
  };

  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      cwd: options.cwd,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: process.platform === 'win32' ? 30000 : 10000,
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
  console.log('\n=== Testing install.sh ===\n');

  let passed = 0;
  let failed = 0;

  if (process.platform === 'win32') {
    console.log('  - skipped on Windows; install.ps1 covers the native wrapper path');
    console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
    process.exit(0);
  }

  if (test('delegates to the Node installer and preserves dry-run output', () => {
    const homeDir = createTempDir('install-sh-home-');
    const projectDir = createTempDir('install-sh-project-');

    try {
      const result = run(['--target', 'cursor', '--dry-run', 'typescript'], {
        cwd: projectDir,
        homeDir,
      });

      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('Dry-run install plan'));
      assert.ok(!fs.existsSync(path.join(projectDir, '.cursor', 'hooks.json')));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('exposes the corrected Gemini target help text', () => {
    const result = run(['--help']);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(
      result.stdout.includes('egc       (default) - Install EGC into ~/.gemini/'),
      'help text should describe the Gemini target as a full ~/.gemini install surface'
    );
  })) passed++; else failed++;

  if (test('installs deps without a lockfile and skips build when src/ is absent (regression #643)', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');

    // A clean `npm install -g @egchq/egc` + `egc install` unpacks a tarball with
    // no root/guardian/memory package-lock.json (npm strips the root lockfile and
    // the sub-package lockfiles are not in package.json "files"), so a bare
    // `npm ci` aborts before Guardian and Memory are ever installed.
    assert.ok(
      /install_deps\s*\(\)\s*\{/.test(script),
      'install.sh must define an install_deps helper'
    );
    assert.ok(
      /-f\s+package-lock\.json/.test(script) && /npm install/.test(script),
      'install_deps must fall back to npm install when no lockfile is present'
    );

    // npm ci may appear only inside install_deps, never as a bare install step.
    const bareNpmCi = script
      .split('\n')
      .filter(line => /^\s*npm ci\b/.test(line));
    assert.strictEqual(
      bareNpmCi.length,
      1,
      `npm ci must live only inside install_deps (found ${bareNpmCi.length} occurrences)`
    );

    // The published package ships build/ but not src/, so the TypeScript build
    // must be guarded by a src/ presence check.
    assert.ok(
      /if\s+\[\s+-d\s+src\s+\]/.test(script),
      'npm run build must be guarded by an "if [ -d src ]" check'
    );
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
