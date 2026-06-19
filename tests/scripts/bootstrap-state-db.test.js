'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'bootstrap-state-db.js');
const { bootstrap } = require('../../scripts/bootstrap-state-db');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  ✓ ${name}`);
        return true;
      }).catch(err => {
        console.log(`  ✗ ${name}`);
        console.log(`    Error: ${err.message}`);
        return false;
      });
    }
    console.log(`  ✓ ${name}`);
    return Promise.resolve(true);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return Promise.resolve(false);
  }
}

async function runTests() {
  console.log('\n=== Testing scripts/bootstrap-state-db.js ===\n');

  let passed = 0;
  let failed = 0;

  if (await test('bootstrap returns ok:true with in-memory database', async () => {
    const result = await bootstrap({ dbPath: ':memory:' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.dbPath, ':memory:');
    assert.ok(Array.isArray(result.migrations));
  })) passed++; else failed++;

  if (await test('bootstrap creates state.db in the specified path', async () => {
    const tempDir = createTempDir('egc-bootstrap-');
    try {
      const dbPath = path.join(tempDir, 'state.db');
      const result = await bootstrap({ dbPath });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.dbPath, dbPath);
      assert.ok(fs.existsSync(dbPath));
    } finally {
      cleanup(tempDir);
    }
  })) passed++; else failed++;

  if (await test('bootstrap applies migrations idempotently on repeated calls', async () => {
    const result1 = await bootstrap({ dbPath: ':memory:' });
    const result2 = await bootstrap({ dbPath: ':memory:' });
    assert.strictEqual(result1.ok, true);
    assert.strictEqual(result2.ok, true);
    assert.deepStrictEqual(
      result1.migrations.map(m => m.version),
      result2.migrations.map(m => m.version)
    );
  })) passed++; else failed++;

  if (await test('bootstrap script prints OK line and exits 0 when run as main', async () => {
    const tempDir = createTempDir('egc-bootstrap-cli-');
    try {
      const egcDir = path.join(tempDir, '.egc');
      const result = spawnSync(process.execPath, [SCRIPT], {
        env: { ...process.env, EGC_DIR: egcDir },
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      });
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(result.stderr.includes('[bootstrap-state-db]'), `unexpected stderr: ${result.stderr}`);
    } finally {
      cleanup(tempDir);
    }
  })) passed++; else failed++;

  if (await test('bootstrap script prints FAILED and exits 1 when state store cannot be created', async () => {
    const tempFile = path.join(os.tmpdir(), `egc-not-a-dir-${Date.now()}`);
    fs.writeFileSync(tempFile, 'x');
    try {
      const result = spawnSync(process.execPath, [SCRIPT], {
        env: { ...process.env, EGC_DIR: tempFile },
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      assert.strictEqual(result.status, 1);
      assert.ok(
        result.stderr.includes('[bootstrap-state-db] FAILED:'),
        `expected FAILED in stderr, got: ${result.stderr}`
      );
    } finally {
      try { fs.unlinkSync(tempFile); } catch (_) {}
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
