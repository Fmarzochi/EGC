'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'check-native-sqlite.js');

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

function runTests() {
  console.log('\n=== Testing check-native-sqlite.js ===\n');
  let passed = 0;
  let failed = 0;

  if (test('exits 0 quietly when the native sqlite3 binary loads', () => {
    let native = true;
    try { require('sqlite3'); } catch { native = false; }
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
    if (native) {
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, '');
    } else {
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.trim().length > 0, 'the reason must be printed');
    }
  })) passed++; else failed++;

  if (test('reports the load failure on stderr with exit 1 when the binary is unusable', () => {
    // NODE_PATH cannot hide sqlite3 from a checkout that has it, so the
    // failure branch is exercised by pointing the probe at a copy of the
    // script placed where sqlite3 does not resolve.
    const os = require('os');
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-native-sqlite-'));
    try {
      const copy = path.join(dir, 'check-native-sqlite.js');
      fs.copyFileSync(SCRIPT, copy);
      const result = spawnSync(process.execPath, [copy], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, timeout: CLI_TIMEOUT_MS });
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("Cannot find module 'sqlite3'"), result.stderr);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
