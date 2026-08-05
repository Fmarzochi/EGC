/**
 * Tests for scripts/repair.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { FULL_INSTALL_TIMEOUT_MS: SUBPROCESS_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const INSTALL_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'install-apply.js');
const DOCTOR_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'doctor.js');
const REPAIR_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'repair.js');
const REPO_ROOT = path.join(__dirname, '..', '..');
const CURRENT_PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
).version;
const CURRENT_MANIFEST_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'manifests', 'install-modules.json'), 'utf8')
).version;
const {
  createInstallState,
  writeInstallState,
} = require('../../scripts/lib/install-state');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function writeState(filePath, options) {
  const state = createInstallState(options);
  writeInstallState(filePath, state);
  return state;
}

function runNode(scriptPath, args = [], options = {}) {
  const homeDir = options.homeDir || process.env.HOME;
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
  };

  try {
    const stdout = execFileSync('node', [scriptPath, ...args], {
      cwd: options.cwd,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: SUBPROCESS_TIMEOUT_MS,
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

  if (test('repairs drifted files from a real install-apply state', () => {
    const homeDir = createTempDir('repair-home-');
    const projectRoot = createTempDir('repair-project-');

    try {
      const installResult = runNode(INSTALL_SCRIPT, ['--target', 'cursor', 'typescript'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(installResult.code, 0, installResult.stderr);

      const normalizedProjectRoot = fs.realpathSync(projectRoot);
      const managedPath = path.join(normalizedProjectRoot, '.cursor', 'hooks', 'session-start.js');
      const statePath = path.join(normalizedProjectRoot, '.cursor', 'egc-install-state.json');
      const expectedContent = fs.readFileSync(
        path.join(REPO_ROOT, '.cursor', 'hooks', 'session-start.js'),
        'utf8'
      );
      fs.writeFileSync(managedPath, '// drifted\n');

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
      assert.ok(parsed.results[0].repairedPaths.includes(managedPath));
      assert.strictEqual(fs.readFileSync(managedPath, 'utf8'), expectedContent);
      assert.ok(fs.existsSync(statePath));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('repairs what it can when one source file is orphaned, instead of abandoning the target', () => {
    const homeDir = createTempDir('repair-home-');
    const projectRoot = createTempDir('repair-project-');

    try {
      const installResult = runNode(INSTALL_SCRIPT, ['--target', 'cursor', 'typescript'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(installResult.code, 0, installResult.stderr);

      const normalizedProjectRoot = fs.realpathSync(projectRoot);
      const managedPath = path.join(normalizedProjectRoot, '.cursor', 'hooks', 'session-start.js');
      const statePath = path.join(normalizedProjectRoot, '.cursor', 'egc-install-state.json');

      // One real managed file is broken, and a second operation points at a
      // source the reference repo no longer has (renamed away, or synced
      // from a different checkout). Before, the orphan aborted the target
      // and the broken file stayed broken.
      fs.writeFileSync(managedPath, '// drifted\n');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const orphanDestination = path.join(normalizedProjectRoot, '.cursor', 'hooks', 'renamed-away.js');
      // The destination has to exist for this to be the missing-SOURCE path:
      // inspectManagedOperation checks the destination first, so an absent
      // destination would be classified as plain 'missing' instead.
      fs.writeFileSync(orphanDestination, '// installed from a source that is gone\n');
      state.operations.push({
        ...state.operations.find(operation => operation.destinationPath === managedPath),
        sourceRelativePath: '.cursor/hooks/this-file-was-renamed-away.js',
        destinationPath: orphanDestination,
      });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

      const repairResult = runNode(REPAIR_SCRIPT, ['--target', 'cursor', '--json'], {
        cwd: projectRoot,
        homeDir,
      });

      const parsed = JSON.parse(repairResult.stdout);
      const entry = parsed.results[0];
      assert.strictEqual(entry.status, 'partial', 'work was done, but something is still unfixable');
      assert.ok(entry.repairedPaths.includes(managedPath), 'the repairable file must be rebuilt');
      assert.deepStrictEqual(
        entry.unrepairable.map(item => ({ path: item.path, cause: item.cause })),
        [{ path: '.cursor/hooks/this-file-was-renamed-away.js', cause: 'missing-source' }],
        'the orphan must be reported by its recorded relative path, and by cause'
      );
      assert.ok(entry.error.includes('Missing source file(s)'), 'the message must name the cause');
      assert.notStrictEqual(fs.readFileSync(managedPath, 'utf8'), '// drifted\n', 'the drifted file must be restored');
      assert.strictEqual(repairResult.code, 1, 'an orphan still has to be reported as needing attention');
      assert.strictEqual(parsed.summary.unrepairableCount, 1);
      assert.strictEqual(parsed.summary.repairedCount, 1, 'a real run counts the target it repaired');
      assert.strictEqual(parsed.summary.plannedRepairCount, 0, 'nothing was merely planned in a real run');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('a dry-run with both drift and an orphan counts planned work, never repairs', () => {
    const homeDir = createTempDir('repair-home-');
    const projectRoot = createTempDir('repair-project-');

    try {
      const installResult = runNode(INSTALL_SCRIPT, ['--target', 'cursor', 'typescript'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(installResult.code, 0, installResult.stderr);

      const normalizedProjectRoot = fs.realpathSync(projectRoot);
      const managedPath = path.join(normalizedProjectRoot, '.cursor', 'hooks', 'session-start.js');
      const statePath = path.join(normalizedProjectRoot, '.cursor', 'egc-install-state.json');
      const orphanDestination = path.join(normalizedProjectRoot, '.cursor', 'hooks', 'renamed-away.js');

      fs.writeFileSync(managedPath, '// drifted\n');
      fs.writeFileSync(orphanDestination, '// installed from a source that is gone\n');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state.operations.push({
        ...state.operations.find(operation => operation.destinationPath === managedPath),
        sourceRelativePath: '.cursor/hooks/this-file-was-renamed-away.js',
        destinationPath: orphanDestination,
      });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

      const repairResult = runNode(REPAIR_SCRIPT, ['--target', 'cursor', '--dry-run', '--json'], {
        cwd: projectRoot,
        homeDir,
      });

      const parsed = JSON.parse(repairResult.stdout);
      assert.strictEqual(parsed.results[0].status, 'partial');
      assert.strictEqual(parsed.summary.plannedRepairCount, 1, 'a dry run plans, it does not repair');
      assert.strictEqual(parsed.summary.repairedCount, 0, 'a dry run must never report writes it did not make');
      assert.strictEqual(parsed.summary.errorCount, 1, 'the orphan still counts as needing attention');
      assert.strictEqual(fs.readFileSync(managedPath, 'utf8'), '// drifted\n', 'a dry run must not touch the file');
      assert.strictEqual(repairResult.code, 1);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('repairs drifted non-copy managed operations and refreshes install-state', () => {
    const homeDir = createTempDir('repair-home-');
    const projectRoot = createTempDir('repair-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      fs.mkdirSync(targetRoot, { recursive: true });
      const normalizedTargetRoot = fs.realpathSync(targetRoot);
      const statePath = path.join(normalizedTargetRoot, 'egc-install-state.json');
      const jsonPath = path.join(normalizedTargetRoot, 'hooks.json');
      const removedPath = path.join(normalizedTargetRoot, 'legacy-note.txt');
      fs.writeFileSync(jsonPath, JSON.stringify({ existing: true, managed: false }, null, 2));
      fs.writeFileSync(removedPath, 'stale\n');

      writeState(statePath, {
        adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
        targetRoot: normalizedTargetRoot,
        installStatePath: statePath,
        request: {
          profile: null,
          modules: ['platform-configs'],
          includeComponents: [],
          excludeComponents: [],
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: ['platform-configs'],
          skippedModules: [],
        },
        operations: [
          {
            kind: 'merge-json',
            moduleId: 'platform-configs',
            sourceRelativePath: '.cursor/hooks.json',
            destinationPath: jsonPath,
            strategy: 'merge-json',
            ownership: 'managed',
            scaffoldOnly: false,
            mergePayload: {
              managed: true,
              nested: {
                enabled: true,
              },
            },
          },
          {
            kind: 'remove',
            moduleId: 'platform-configs',
            sourceRelativePath: '.cursor/legacy-note.txt',
            destinationPath: removedPath,
            strategy: 'remove',
            ownership: 'managed',
            scaffoldOnly: false,
          },
        ],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const doctorBefore = runNode(DOCTOR_SCRIPT, ['--target', 'cursor', '--json'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(doctorBefore.code, 1);
      assert.ok(JSON.parse(doctorBefore.stdout).results[0].issues.some(issue => issue.code === 'drifted-managed-files'));

      const installedAtBefore = JSON.parse(fs.readFileSync(statePath, 'utf8')).installedAt;
      const repairResult = runNode(REPAIR_SCRIPT, ['--target', 'cursor', '--json'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(repairResult.code, 0, repairResult.stderr);

      const parsed = JSON.parse(repairResult.stdout);
      assert.strictEqual(parsed.results[0].status, 'repaired');
      assert.ok(parsed.results[0].repairedPaths.includes(jsonPath));
      assert.ok(parsed.results[0].repairedPaths.includes(removedPath));
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), {
        existing: true,
        managed: true,
        nested: {
          enabled: true,
        },
      });
      assert.ok(!fs.existsSync(removedPath));

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

  if (test('supports dry-run without mutating drifted non-copy operations', () => {
    const homeDir = createTempDir('repair-home-');
    const projectRoot = createTempDir('repair-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      fs.mkdirSync(targetRoot, { recursive: true });
      const normalizedTargetRoot = fs.realpathSync(targetRoot);
      const statePath = path.join(normalizedTargetRoot, 'egc-install-state.json');
      const jsonPath = path.join(normalizedTargetRoot, 'hooks.json');
      fs.writeFileSync(jsonPath, JSON.stringify({ existing: true, managed: false }, null, 2));

      writeState(statePath, {
        adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
        targetRoot: normalizedTargetRoot,
        installStatePath: statePath,
        request: {
          profile: null,
          modules: ['platform-configs'],
          includeComponents: [],
          excludeComponents: [],
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: ['platform-configs'],
          skippedModules: [],
        },
        operations: [
          {
            kind: 'merge-json',
            moduleId: 'platform-configs',
            sourceRelativePath: '.cursor/hooks.json',
            destinationPath: jsonPath,
            strategy: 'merge-json',
            ownership: 'managed',
            scaffoldOnly: false,
            mergePayload: {
              managed: true,
              nested: {
                enabled: true,
              },
            },
          },
        ],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const repairResult = runNode(REPAIR_SCRIPT, ['--target', 'cursor', '--dry-run', '--json'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(repairResult.code, 0, repairResult.stderr);
      const parsed = JSON.parse(repairResult.stdout);
      assert.strictEqual(parsed.dryRun, true);
      assert.ok(parsed.results[0].plannedRepairs.includes(jsonPath));
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), { existing: true, managed: false });
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('prints a human-readable message when no install-state files exist', () => {
    const homeDir = createTempDir('repair-home-');
    const projectRoot = createTempDir('repair-project-');

    try {
      const repairResult = runNode(REPAIR_SCRIPT, ['--target', 'cursor'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(repairResult.code, 0, repairResult.stderr);
      assert.ok(repairResult.stdout.includes(
        'No EGC install-state files found for the current home/project context.'
      ));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('prints a human-readable repair summary for repaired entries', () => {
    const homeDir = createTempDir('repair-home-');
    const projectRoot = createTempDir('repair-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      fs.mkdirSync(targetRoot, { recursive: true });
      const normalizedTargetRoot = fs.realpathSync(targetRoot);
      const statePath = path.join(normalizedTargetRoot, 'egc-install-state.json');
      const jsonPath = path.join(normalizedTargetRoot, 'hooks.json');
      fs.writeFileSync(jsonPath, JSON.stringify({ existing: true, managed: false }, null, 2));

      writeState(statePath, {
        adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
        targetRoot: normalizedTargetRoot,
        installStatePath: statePath,
        request: {
          profile: null,
          modules: ['platform-configs'],
          includeComponents: [],
          excludeComponents: [],
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: ['platform-configs'],
          skippedModules: [],
        },
        operations: [
          {
            kind: 'merge-json',
            moduleId: 'platform-configs',
            sourceRelativePath: '.cursor/hooks.json',
            destinationPath: jsonPath,
            strategy: 'merge-json',
            ownership: 'managed',
            scaffoldOnly: false,
            mergePayload: {
              managed: true,
            },
          },
        ],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const repairResult = runNode(REPAIR_SCRIPT, ['--target', 'cursor'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(repairResult.code, 0, repairResult.stderr);
      assert.ok(repairResult.stdout.includes('Repair summary:'));
      assert.ok(repairResult.stdout.includes('- cursor-project'));
      assert.ok(repairResult.stdout.includes('Status: REPAIRED'));
      assert.ok(repairResult.stdout.includes(`Install-state: ${statePath}`));
      assert.ok(repairResult.stdout.includes('Repaired paths: 1'));
      assert.ok(/Summary: checked=1, repaired=1, errors=0/.test(repairResult.stdout));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('prints a human-readable error line when an install-state entry cannot be read', () => {
    const homeDir = createTempDir('repair-home-');
    const projectRoot = createTempDir('repair-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      fs.mkdirSync(targetRoot, { recursive: true });
      const normalizedTargetRoot = fs.realpathSync(targetRoot);
      const statePath = path.join(normalizedTargetRoot, 'egc-install-state.json');
      fs.writeFileSync(statePath, '{ not valid json');

      const repairResult = runNode(REPAIR_SCRIPT, ['--target', 'cursor'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(repairResult.code, 1, repairResult.stderr);
      assert.ok(repairResult.stdout.includes('Repair summary:'));
      assert.ok(repairResult.stdout.includes('Status: ERROR'));
      assert.ok(repairResult.stdout.includes('Error: '));
      assert.ok(!repairResult.stdout.includes('Repaired paths:'));
      assert.ok(/Summary: checked=1, repaired=0, errors=1/.test(repairResult.stdout));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('includes plugin reinstall results in JSON output when plugins are installed', () => {
    const homeDir = createTempDir('repair-home-');
    const projectRoot = createTempDir('repair-project-');

    try {
      const pluginsDir = path.join(homeDir, '.egc', 'plugins');
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(path.join(pluginsDir, 'plugins.json'), JSON.stringify({
        schemaVersion: 'egc.plugins.v1',
        installed: {
          'example-plugin': { name: 'example-plugin', version: '1.0.0' },
        },
      }, null, 2));

      const repairResult = runNode(REPAIR_SCRIPT, ['--target', 'cursor', '--json'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(repairResult.code, 1, repairResult.stderr);

      const parsed = JSON.parse(repairResult.stdout);
      assert.ok(Array.isArray(parsed.pluginRepairs));
      assert.strictEqual(parsed.pluginRepairs.length, 1);
      assert.strictEqual(parsed.pluginRepairs[0].name, 'example-plugin');
      assert.strictEqual(parsed.pluginRepairs[0].success, false);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('prints plugin reinstall results in human-readable output', () => {
    const homeDir = createTempDir('repair-home-');
    const projectRoot = createTempDir('repair-project-');

    try {
      const pluginsDir = path.join(homeDir, '.egc', 'plugins');
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(path.join(pluginsDir, 'plugins.json'), JSON.stringify({
        schemaVersion: 'egc.plugins.v1',
        installed: {
          'example-plugin': { name: 'example-plugin', version: '1.0.0' },
        },
      }, null, 2));

      const repairResult = runNode(REPAIR_SCRIPT, ['--target', 'cursor'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(repairResult.code, 1, repairResult.stderr);
      assert.ok(repairResult.stdout.includes(
        'No EGC install-state files found for the current home/project context.'
      ));
      assert.ok(repairResult.stdout.includes('Plugin reinstall:'));
      assert.ok(repairResult.stdout.includes('✗ example-plugin: plugin.json missing; cannot reinstall'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('exits with an error message for an unknown CLI argument', () => {
    const homeDir = createTempDir('repair-home-');
    const projectRoot = createTempDir('repair-project-');

    try {
      const repairResult = runNode(REPAIR_SCRIPT, ['--not-a-real-flag'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(repairResult.code, 1);
      assert.ok(repairResult.stderr.includes('Error: Unknown argument: --not-a-real-flag'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
