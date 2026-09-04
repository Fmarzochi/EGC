/**
 * Tests for scripts/lib/install-state.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CURRENT_PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
).version;

const {
  createInstallState,
  readInstallState,
  writeInstallState,
} = require('../../scripts/lib/install-state');

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

function createTestDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-'));
}

function cleanupTestDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function runTests() {
  console.log('\n=== Testing install-state.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('creates a valid install-state payload', () => {
    const state = createInstallState({
      adapter: { id: 'cursor-project' },
      targetRoot: '/repo/.cursor',
      installStatePath: '/repo/.cursor/egc-install-state.json',
      request: {
        profile: 'developer',
        modules: ['orchestration'],
        legacyLanguages: ['typescript'],
        legacyMode: true,
      },
      resolution: {
        selectedModules: ['rules-core', 'orchestration'],
        skippedModules: [],
      },
      operations: [
        {
          kind: 'copy-path',
          moduleId: 'rules-core',
          sourceRelativePath: 'rules',
          destinationPath: '/repo/.cursor/rules',
          strategy: 'preserve-relative-path',
          ownership: 'managed',
          scaffoldOnly: true,
        },
      ],
      source: {
        repoVersion: CURRENT_PACKAGE_VERSION,
        repoCommit: 'abc123',
        manifestVersion: 1,
      },
      installedAt: '2026-03-13T00:00:00Z',
    });

    assert.strictEqual(state.schemaVersion, 'egc.install.v1');
    assert.strictEqual(state.target.id, 'cursor-project');
    assert.strictEqual(state.request.profile, 'developer');
    assert.strictEqual(state.operations.length, 1);
  })) passed++; else failed++;

  if (test('writes and reads install-state from disk', () => {
    const testDir = createTestDir();
    const statePath = path.join(testDir, 'egc-install-state.json');

    try {
      const state = createInstallState({
        adapter: { id: 'egc-home' },
        targetRoot: path.join(testDir, '.gemini'),
        installStatePath: statePath,
        request: {
          profile: 'core',
          modules: [],
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: ['rules-core'],
          skippedModules: [],
        },
        operations: [],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: 1,
        },
      });

      writeInstallState(statePath, state);
      const loaded = readInstallState(statePath);

      assert.strictEqual(loaded.target.id, 'egc-home');
      assert.strictEqual(loaded.request.profile, 'core');
      assert.deepStrictEqual(loaded.resolution.selectedModules, ['rules-core']);
    } finally {
      cleanupTestDir(testDir);
    }
  })) passed++; else failed++;

  if (test('deep-clones nested operation metadata for lifecycle-managed operations', () => {
    const operation = {
      kind: 'merge-json',
      moduleId: 'platform-configs',
      sourceRelativePath: '.cursor/hooks.json',
      destinationPath: '/repo/.cursor/hooks.json',
      strategy: 'merge-json',
      ownership: 'managed',
      scaffoldOnly: false,
      mergePayload: {
        nested: {
          enabled: true,
        },
      },
      previousValue: {
        nested: {
          enabled: false,
        },
      },
    };

    const state = createInstallState({
      adapter: { id: 'cursor-project' },
      targetRoot: '/repo/.cursor',
      installStatePath: '/repo/.cursor/egc-install-state.json',
      request: {
        profile: null,
        modules: ['platform-configs'],
        legacyLanguages: [],
        legacyMode: false,
      },
      resolution: {
        selectedModules: ['platform-configs'],
        skippedModules: [],
      },
      operations: [operation],
      source: {
        repoVersion: CURRENT_PACKAGE_VERSION,
        repoCommit: 'abc123',
        manifestVersion: 1,
      },
    });

    operation.mergePayload.nested.enabled = false;
    operation.previousValue.nested.enabled = true;

    assert.strictEqual(state.operations[0].mergePayload.nested.enabled, true);
    assert.strictEqual(state.operations[0].previousValue.nested.enabled, false);
  })) passed++; else failed++;

  if (test('rejects invalid install-state payloads on read', () => {
    const testDir = createTestDir();
    const statePath = path.join(testDir, 'egc-install-state.json');

    try {
      fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 'egc.install.v1' }, null, 2));
      assert.throws(
        () => readInstallState(statePath),
        /Invalid install-state/
      );
    } finally {
      cleanupTestDir(testDir);
    }
  })) passed++; else failed++;

  if (test('rejects operations whose paths climb or are not anchored where they must be', () => {
    const base = {
      adapter: { id: 'cursor-project' },
      targetRoot: '/repo/.cursor',
      installStatePath: '/repo/.cursor/egc-install-state.json',
      request: { profile: null, modules: [], includeComponents: [], excludeComponents: [], legacyLanguages: [], legacyMode: false },
      resolution: { selectedModules: [], skippedModules: [] },
      source: { repoVersion: '1.0.0', repoCommit: 'abc', manifestVersion: 1 },
    };
    const operation = { kind: 'copy-file', moduleId: 'rules-core', sourceRelativePath: 'rules/x.md', destinationPath: '/repo/.cursor/rules/x.md', strategy: 'overwrite', ownership: 'managed', scaffoldOnly: false };
    const testDir = createTestDir();
    const statePath = path.join(testDir, 'egc-install-state.json');
    try {
      for (const tampered of [
        { sourceRelativePath: '../../home/user/.ssh/id_rsa' },
        { sourceRelativePath: '/etc/passwd' },
        { destinationPath: '/repo/.cursor/../../home/user/.bashrc' },
        { destinationPath: 'relative/path' },
      ]) {
        // createInstallState validates on creation, so the tampered operation
        // never even becomes a state object; a hand-written file is refused on read.
        assert.throws(() => createInstallState({ ...base, operations: [{ ...operation, ...tampered }] }), /Invalid install-state/, JSON.stringify(tampered));
        const clean = createInstallState({ ...base, operations: [operation] });
        const handWritten = { ...clean, operations: [{ ...clean.operations[0], ...tampered }] };
        fs.writeFileSync(statePath, JSON.stringify(handWritten, null, 2));
        assert.throws(() => readInstallState(statePath), /Invalid install-state/, JSON.stringify(tampered));
      }
      const clean = createInstallState({ ...base, operations: [operation] });
      fs.writeFileSync(statePath, JSON.stringify(clean, null, 2));
      assert.strictEqual(readInstallState(statePath).operations.length, 1);
      // Anchored on the other platform family is still anchored: a state file
      // written on Windows validates the same way on POSIX and the reverse.
      for (const destinationPath of ['C:\\repo\\.cursor\\x.md', '\\\\server\\share\\x.md']) {
        assert.doesNotThrow(() => createInstallState({ ...base, operations: [{ ...operation, destinationPath }] }), destinationPath);
      }
    } finally {
      cleanupTestDir(testDir);
    }
  })) passed++; else failed++;

  if (test('rejects unexpected properties and missing required request fields', () => {
    const testDir = createTestDir();
    const statePath = path.join(testDir, 'egc-install-state.json');

    try {
      fs.writeFileSync(statePath, JSON.stringify({
        schemaVersion: 'egc.install.v1',
        installedAt: '2026-03-13T00:00:00Z',
        unexpected: true,
        target: {
          id: 'cursor-project',
          root: '/repo/.cursor',
          installStatePath: '/repo/.cursor/egc-install-state.json',
        },
        request: {
          modules: [],
          includeComponents: [],
          excludeComponents: [],
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: [],
          skippedModules: [],
        },
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: 1,
        },
        operations: [],
      }, null, 2));

      assert.throws(
        () => readInstallState(statePath),
        /Invalid install-state/
      );
    } finally {
      cleanupTestDir(testDir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
