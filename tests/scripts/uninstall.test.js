/**
 * Tests for scripts/uninstall.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const INSTALL_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'install-apply.js');
const UNINSTALL_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'uninstall.js');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function runNode(scriptPath, args = [], options = {}) {
  const env = {
    ...process.env,
    HOME: options.homeDir || process.env.HOME,
  };

  try {
    const stdout = execFileSync('node', [scriptPath, ...args], {
      cwd: options.cwd,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
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
  console.log('\n=== Testing uninstall.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('removes managed files and keeps unrelated files', () => {
    const homeDir = createTempDir('uninstall-home-');
    const projectRoot = createTempDir('uninstall-project-');

    try {
      const installResult = runNode(INSTALL_SCRIPT, ['--target', 'cursor', '--modules', 'platform-configs'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(installResult.code, 0, installResult.stderr);

      const cursorRoot = path.join(projectRoot, '.cursor');
      const managedPath = path.join(cursorRoot, 'hooks.json');
      const statePath = path.join(cursorRoot, 'ecc-install-state.json');
      const unrelatedPath = path.join(cursorRoot, 'custom-user-note.txt');
      fs.writeFileSync(unrelatedPath, 'leave me alone');

      const uninstallResult = runNode(UNINSTALL_SCRIPT, ['--target', 'cursor'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(uninstallResult.code, 0, uninstallResult.stderr);
      assert.ok(uninstallResult.stdout.includes('Uninstall summary'));
      assert.ok(!fs.existsSync(managedPath));
      assert.ok(!fs.existsSync(statePath));
      assert.ok(fs.existsSync(unrelatedPath));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('supports dry-run without removing files', () => {
    const homeDir = createTempDir('uninstall-home-');
    const projectRoot = createTempDir('uninstall-project-');

    try {
      const installResult = runNode(INSTALL_SCRIPT, ['--target', 'cursor', '--modules', 'platform-configs'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(installResult.code, 0, installResult.stderr);

      const cursorRoot = path.join(projectRoot, '.cursor');
      const managedPath = path.join(cursorRoot, 'hooks.json');
      const statePath = path.join(cursorRoot, 'ecc-install-state.json');

      const uninstallResult = runNode(UNINSTALL_SCRIPT, ['--target', 'cursor', '--dry-run', '--json'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(uninstallResult.code, 0, uninstallResult.stderr);

      const parsed = JSON.parse(uninstallResult.stdout);
      assert.strictEqual(parsed.dryRun, true);
      assert.ok(parsed.results[0].plannedRemovals.length > 0);
      assert.ok(fs.existsSync(managedPath));
      assert.ok(fs.existsSync(statePath));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
