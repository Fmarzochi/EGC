/**
 * Uninstall in a tree several targets share.
 *
 * codex-home, goose-home and openhands-home all install into ~/.agents, each
 * under its own install-state. These tests pin what uninstalling one of them
 * leaves for the others.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { uninstallInstalledStates } = require('../../scripts/lib/install-lifecycle');
const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const MANIFEST_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'manifests', 'install-modules.json'), 'utf8')
).version;

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

function copyOperation(destinationPath) {
  return {
    kind: 'copy-file',
    moduleId: 'test-module',
    sourceRelativePath: 'rules/common/coding-style.md',
    destinationPath,
    strategy: 'copy-file',
    ownership: 'managed',
    scaffoldOnly: false,
  };
}

function statePathOf(homeDir, target) {
  return path.join(homeDir, '.agents', 'egc', `${target}-install-state.json`);
}

function writeSharedTreeState(homeDir, target, destinations) {
  const installStatePath = statePathOf(homeDir, target);
  writeInstallState(installStatePath, createInstallState({
    adapter: { id: `${target}-home`, target, kind: 'home' },
    targetRoot: path.join(homeDir, '.agents'),
    installStatePath,
    request: {
      profile: null,
      modules: [],
      includeComponents: [],
      excludeComponents: [],
      legacyLanguages: [],
      legacyMode: true,
    },
    resolution: { selectedModules: [], skippedModules: [] },
    operations: destinations.map(copyOperation),
    source: { repoVersion: PACKAGE_VERSION, repoCommit: 'abc123', manifestVersion: MANIFEST_VERSION },
  }));
  return installStatePath;
}

function writeFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'managed\n');
}

// A home where codex and goose both record the shared skill, and codex also
// records one of its own.
function sharedTreeFixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-tree-home-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-tree-project-'));
  const shared = path.join(homeDir, '.agents', 'skills', 'shared-skill', 'SKILL.md');
  const codexOnly = path.join(homeDir, '.agents', 'skills', 'codex-skill', 'SKILL.md');
  writeFile(shared);
  writeFile(codexOnly);
  const codexState = writeSharedTreeState(homeDir, 'codex', [shared, codexOnly]);
  const gooseState = writeSharedTreeState(homeDir, 'goose', [shared]);
  return { homeDir, projectRoot, shared, codexOnly, codexState, gooseState };
}

function cleanup(fixture) {
  fs.rmSync(fixture.homeDir, { recursive: true, force: true });
  fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
}

function resultFor(report, adapterId) {
  const result = report.results.find(entry => entry.adapter.id === adapterId);
  assert.ok(result, `expected a result for ${adapterId}`);
  return result;
}

function runTests() {
  console.log('\n=== Testing uninstall in a shared tree ===\n');

  let passed = 0;
  let failed = 0;
  const tally = ok => (ok ? passed++ : failed++);

  tally(test('uninstalling one target leaves the files a sibling still records', () => {
    const fixture = sharedTreeFixture();
    try {
      const report = uninstallInstalledStates({
        homeDir: fixture.homeDir,
        projectRoot: fixture.projectRoot,
        targets: ['codex'],
      });
      const codex = resultFor(report, 'codex-home');

      assert.strictEqual(codex.status, 'uninstalled');
      assert.ok(fs.existsSync(fixture.shared), 'the file goose still records must stay');
      assert.ok(!fs.existsSync(fixture.codexOnly), 'the file only codex records must go');
      assert.ok(!fs.existsSync(fixture.codexState), 'the codex install-state must go');
      assert.ok(fs.existsSync(fixture.gooseState), 'the goose install-state must stay');
      assert.deepStrictEqual(codex.keptPaths, [fixture.shared]);
      assert.ok(codex.removedPaths.includes(fixture.codexOnly));
      assert.ok(!codex.removedPaths.includes(fixture.shared));
    } finally {
      cleanup(fixture);
    }
  }));

  tally(test('the last target to leave takes the shared files with it', () => {
    const fixture = sharedTreeFixture();
    try {
      const report = uninstallInstalledStates({
        homeDir: fixture.homeDir,
        projectRoot: fixture.projectRoot,
        targets: ['codex', 'goose'],
      });

      assert.strictEqual(resultFor(report, 'codex-home').status, 'uninstalled');
      assert.strictEqual(resultFor(report, 'goose-home').status, 'uninstalled');
      assert.ok(!fs.existsSync(fixture.shared), 'no target records the file any more');
      assert.ok(!fs.existsSync(fixture.codexOnly));
      assert.ok(!fs.existsSync(fixture.codexState));
      assert.ok(!fs.existsSync(fixture.gooseState));
    } finally {
      cleanup(fixture);
    }
  }));

  tally(test('a dry run lists the kept files apart from the planned removals', () => {
    const fixture = sharedTreeFixture();
    try {
      const report = uninstallInstalledStates({
        homeDir: fixture.homeDir,
        projectRoot: fixture.projectRoot,
        targets: ['codex'],
        dryRun: true,
      });
      const codex = resultFor(report, 'codex-home');

      assert.strictEqual(codex.status, 'planned');
      assert.deepStrictEqual(codex.keptPaths, [fixture.shared]);
      assert.ok(codex.plannedRemovals.includes(fixture.codexOnly));
      assert.ok(!codex.plannedRemovals.includes(fixture.shared));
      assert.ok(fs.existsSync(fixture.shared));
      assert.ok(fs.existsSync(fixture.codexOnly));
    } finally {
      cleanup(fixture);
    }
  }));

  tally(test('a dry run over several targets plans what the real run does', () => {
    const fixture = sharedTreeFixture();
    try {
      const report = uninstallInstalledStates({
        homeDir: fixture.homeDir,
        projectRoot: fixture.projectRoot,
        targets: ['codex', 'goose'],
        dryRun: true,
      });
      const codex = resultFor(report, 'codex-home');
      const goose = resultFor(report, 'goose-home');

      assert.deepStrictEqual(codex.keptPaths, [fixture.shared], 'goose still records it when codex leaves');
      assert.deepStrictEqual(goose.keptPaths, [], 'goose is the last to leave');
      assert.ok(goose.plannedRemovals.includes(fixture.shared));
      assert.ok(fs.existsSync(fixture.shared));
      assert.ok(fs.existsSync(fixture.codexState));
      assert.ok(fs.existsSync(fixture.gooseState));
    } finally {
      cleanup(fixture);
    }
  }));

  tally(test('a file a sibling records in another letter case is kept where the file system folds case', () => {
    const fixture = sharedTreeFixture();
    try {
      writeSharedTreeState(fixture.homeDir, 'goose', [fixture.shared.replace('shared-skill', 'SHARED-SKILL')]);
      const foldsCase = process.platform === 'win32' || process.platform === 'darwin';

      const report = uninstallInstalledStates({
        homeDir: fixture.homeDir,
        projectRoot: fixture.projectRoot,
        targets: ['codex'],
      });

      assert.strictEqual(resultFor(report, 'codex-home').status, 'uninstalled');
      assert.strictEqual(fs.existsSync(fixture.shared), foldsCase);
    } finally {
      cleanup(fixture);
    }
  }));

  const linkedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-tree-link-'));
  let links = true;
  try {
    fs.symlinkSync(os.tmpdir(), path.join(linkedHome, 'probe'), 'dir');
  } catch (error) {
    links = false;
    console.log(`  - skipped: cannot create symlinks here (${error.code})`);
  }
  if (links) {
    tally(test('a file a sibling records through a linked folder is kept', () => {
      const fixture = sharedTreeFixture();
      try {
        const throughLink = path.join(linkedHome, 'home');
        fs.symlinkSync(fixture.homeDir, throughLink, 'dir');
        writeSharedTreeState(fixture.homeDir, 'goose', [
          path.join(throughLink, '.agents', 'skills', 'shared-skill', 'SKILL.md'),
        ]);

        const report = uninstallInstalledStates({
          homeDir: fixture.homeDir,
          projectRoot: fixture.projectRoot,
          targets: ['codex'],
        });
        const codex = resultFor(report, 'codex-home');

        assert.strictEqual(codex.status, 'uninstalled');
        assert.deepStrictEqual(codex.keptPaths, [fixture.shared]);
        assert.ok(fs.existsSync(fixture.shared));
      } finally {
        cleanup(fixture);
      }
    }));
  }
  fs.rmSync(linkedHome, { recursive: true, force: true });

  tally(test('a sibling install-state that cannot be read refuses the uninstall and changes nothing', () => {
    const fixture = sharedTreeFixture();
    try {
      fs.writeFileSync(fixture.gooseState, '{ not json');

      const report = uninstallInstalledStates({
        homeDir: fixture.homeDir,
        projectRoot: fixture.projectRoot,
        targets: ['codex'],
      });
      const codex = resultFor(report, 'codex-home');

      assert.strictEqual(codex.status, 'error');
      assert.ok(codex.error.includes(fixture.gooseState), codex.error);
      assert.ok(fs.existsSync(fixture.shared));
      assert.ok(fs.existsSync(fixture.codexOnly));
      assert.ok(fs.existsSync(fixture.codexState));
    } finally {
      cleanup(fixture);
    }
  }));

  tally(test('a target with no sibling install uninstalls as before', () => {
    const fixture = sharedTreeFixture();
    try {
      fs.rmSync(fixture.gooseState, { force: true });

      const report = uninstallInstalledStates({
        homeDir: fixture.homeDir,
        projectRoot: fixture.projectRoot,
        targets: ['codex'],
      });
      const codex = resultFor(report, 'codex-home');

      assert.strictEqual(codex.status, 'uninstalled');
      assert.deepStrictEqual(codex.keptPaths, []);
      assert.ok(!fs.existsSync(fixture.shared));
      assert.ok(!fs.existsSync(fixture.codexOnly));
    } finally {
      cleanup(fixture);
    }
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
