/**
 * Tests for scripts/repair.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const INSTALL_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'install-apply.js');
const DOCTOR_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'doctor.js');
const REPAIR_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'repair.js');
const REPO_ROOT = path.join(__dirname, '..', '..');

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
  console.log('\n=== Testing repair.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('repairs drifted managed files and refreshes install-state', () => {
    const homeDir = createTempDir('repair-home-');
    const projectRoot = createTempDir('repair-project-');

    try {
      const installResult = runNode(INSTALL_SCRIPT, ['--target', 'cursor', '--modules', 'platform-configs'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(installResult.code, 0, installResult.stderr);

      const cursorRoot = path.join(projectRoot, '.cursor');
      const managedPath = path.join(cursorRoot, 'hooks.json');
      const statePath = path.join(cursorRoot, 'ecc-install-state.json');
      const managedRealPath = fs.realpathSync(cursorRoot);
      const expectedManagedPath = path.join(managedRealPath, 'hooks.json');
      const expectedContent = fs.readFileSync(path.join(REPO_ROOT, '.cursor', 'hooks.json'), 'utf8');
      const installedAtBefore = JSON.parse(fs.readFileSync(statePath, 'utf8')).installedAt;

      fs.writeFileSync(managedPath, '{"drifted":true}\n');

      const doctorBefore = runNode(DOCTOR_SCRIPT, ['--target', 'cursor', '--json'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(doctorBefore.code, 1);
      assert.ok(JSON.parse(doctorBefore.stdout).results[0].issues.some(issue => issue.code === 'drifted-managed-files'));

      const repairResult = runNode(REPAIR_SCRIPT, ['--target', 'cursor', '--json'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(repairResult.code, 0, repairResult.stderr);

      const parsed = JSON.parse(repairResult.stdout);
      assert.strictEqual(parsed.results[0].status, 'repaired');
      assert.ok(parsed.results[0].repairedPaths.includes(expectedManagedPath));
      assert.strictEqual(fs.readFileSync(managedPath, 'utf8'), expectedContent);

      const repairedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.strictEqual(repairedState.installedAt, installedAtBefore);
      assert.ok(repairedState.lastValidatedAt);

      const doctorAfter = runNode(DOCTOR_SCRIPT, ['--target', 'cursor'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(doctorAfter.code, 0, doctorAfter.stderr);
      assert.ok(doctorAfter.stdout.includes('Status: OK'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('supports dry-run without mutating drifted files', () => {
    const homeDir = createTempDir('repair-home-');
    const projectRoot = createTempDir('repair-project-');

    try {
      const installResult = runNode(INSTALL_SCRIPT, ['--target', 'cursor', '--modules', 'platform-configs'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(installResult.code, 0, installResult.stderr);

      const cursorRoot = path.join(projectRoot, '.cursor');
      const managedPath = path.join(cursorRoot, 'hooks.json');
      const managedRealPath = fs.realpathSync(cursorRoot);
      const expectedManagedPath = path.join(managedRealPath, 'hooks.json');
      const driftedContent = '{"drifted":true}\n';
      fs.writeFileSync(managedPath, driftedContent);

      const repairResult = runNode(REPAIR_SCRIPT, ['--target', 'cursor', '--dry-run', '--json'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(repairResult.code, 0, repairResult.stderr);
      const parsed = JSON.parse(repairResult.stdout);
      assert.strictEqual(parsed.dryRun, true);
      assert.ok(parsed.results[0].plannedRepairs.includes(expectedManagedPath));
      assert.strictEqual(fs.readFileSync(managedPath, 'utf8'), driftedContent);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
