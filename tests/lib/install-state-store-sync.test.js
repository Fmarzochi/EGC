/**
 * Tests for scripts/lib/install-state-store-sync.js
 *
 * Regression coverage for the bug where `egc status` always reported
 * "Install health: missing" -- upsertInstallState() existed in the
 * state-store but nothing in the install pipeline ever called it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { syncInstallStateToStore } = require('../../scripts/lib/install-state-store-sync');
const { createStateStore } = require('../../scripts/lib/state-store');
const { createInstallState } = require('../../scripts/lib/install-state');

async function test(name, fn) {
  try {
    await fn();
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

function cleanupTempDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function buildSampleState(overrides = {}) {
  return createInstallState({
    adapter: { id: 'claude-home' },
    targetRoot: '/home/tester/.claude',
    installStatePath: '/home/tester/.claude/egc/install-state.json',
    request: {
      profile: 'full',
      modules: ['rules-core'],
      legacyLanguages: [],
      legacyMode: false,
    },
    resolution: {
      selectedModules: ['rules-core'],
      skippedModules: [],
    },
    source: {
      repoVersion: '1.1.9',
      manifestVersion: 1,
    },
    operations: [],
    ...overrides,
  });
}

async function runTests() {
  console.log('\n=== Testing install-state-store-sync.js ===\n');

  let passed = 0;
  let failed = 0;

  if (await test('syncInstallStateToStore makes the install visible to getStatus()/installHealth', async () => {
    const tmpDir = createTempDir('install-state-store-sync-');
    const dbPath = path.join(tmpDir, 'state.db');
    try {
      const state = buildSampleState();
      await syncInstallStateToStore(state, { dbPath });

      const store = await createStateStore({ dbPath });
      try {
        const status = store.getStatus({});
        assert.strictEqual(status.installHealth.status, 'healthy');
        assert.strictEqual(status.installHealth.totalCount, 1);
        assert.strictEqual(status.installHealth.installations[0].targetId, 'claude-home');
      } finally {
        store.close();
      }
    } finally {
      cleanupTempDir(tmpDir);
    }
  })) passed++; else failed++;

  if (await test('syncInstallStateToStore upserts, does not duplicate, on repeated calls for the same target', async () => {
    const tmpDir = createTempDir('install-state-store-sync-');
    const dbPath = path.join(tmpDir, 'state.db');
    try {
      const state = buildSampleState();
      await syncInstallStateToStore(state, { dbPath });
      await syncInstallStateToStore(state, { dbPath });

      const store = await createStateStore({ dbPath });
      try {
        const status = store.getStatus({});
        assert.strictEqual(status.installHealth.totalCount, 1, 'a second sync for the same target must update, not duplicate, the row');
      } finally {
        store.close();
      }
    } finally {
      cleanupTempDir(tmpDir);
    }
  })) passed++; else failed++;

  // A path that cannot be created on any OS: mkdir(recursive) must fail when
  // a path segment it needs to create a directory at is already a plain
  // file. Unlike relying on a permission error (EACCES), this failure mode
  // is a filesystem invariant, not an OS-specific permission model, so it
  // reproduces identically on Linux, macOS, and Windows CI runners.
  function makeUnwritableDbPath(tmpDir) {
    const blockerFile = path.join(tmpDir, 'blocker-file');
    fs.writeFileSync(blockerFile, 'not a directory');
    return path.join(blockerFile, 'nested', 'state.db');
  }

  if (await test('syncInstallStateToStore never throws, even when the store cannot be created', async () => {
    const tmpDir = createTempDir('install-state-store-sync-');
    try {
      const unwritableDbPath = makeUnwritableDbPath(tmpDir);
      const state = buildSampleState();

      let onErrorCalled = false;
      await syncInstallStateToStore(state, {
        dbPath: unwritableDbPath,
        onError: () => { onErrorCalled = true; },
      });

      assert.ok(onErrorCalled, 'onError must be invoked so callers can log, but the returned promise must still resolve cleanly');
    } finally {
      cleanupTempDir(tmpDir);
    }
  })) passed++; else failed++;

  if (await test('syncInstallStateToStore resolves without throwing when no onError callback is given', async () => {
    const tmpDir = createTempDir('install-state-store-sync-');
    try {
      const unwritableDbPath = makeUnwritableDbPath(tmpDir);
      const state = buildSampleState();

      await syncInstallStateToStore(state, { dbPath: unwritableDbPath });
    } finally {
      cleanupTempDir(tmpDir);
    }
  })) passed++; else failed++;

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  return failed === 0;
}

if (require.main === module) {
  runTests().then(ok => {
    process.exitCode = ok ? 0 : 1;
  });
}

module.exports = { runTests };
