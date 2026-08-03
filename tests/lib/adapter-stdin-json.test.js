/**
 * Tests for scripts/lib/adapter-stdin-json.js -- the shared truncation-aware
 * stdin JSON reader used by 12+ host adapters (Windsurf, Cursor, Junie,
 * Cline, Amazon Q, Goose, OpenHands).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE_PATH = path.join(__dirname, '..', '..', 'scripts', 'lib', 'adapter-stdin-json.js');
const { MAX_STDIN } = require(MODULE_PATH);

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

// Runs readAdapterStdinJson in a real subprocess (it reads process.stdin
// directly, so it cannot be driven in-process without hijacking stdin for
// the whole test file) and prints the result as JSON on stdout.
const driverPath = path.join(os.tmpdir(), `egc-adapter-stdin-json-driver-${process.pid}.js`);
fs.writeFileSync(driverPath, `
  const { readAdapterStdinJson } = require(${JSON.stringify(MODULE_PATH)});
  readAdapterStdinJson(({ ok, truncated, value }) => {
    process.stdout.write(JSON.stringify({ ok, truncated, hasValue: value !== undefined }));
  });
`);
process.on('exit', () => { try { fs.rmSync(driverPath, { force: true }); } catch { /* best-effort cleanup */ } });

function readViaSubprocess(input) {
  const result = spawnSync(process.execPath, [driverPath], {
    input,
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(result.stdout.toString('utf8'));
}

function runTests() {
  console.log('\n=== Testing scripts/lib/adapter-stdin-json.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('a payload of exactly MAX_STDIN bytes (ASCII) is not marked truncated', () => {
    const prefix = '{"padding":"';
    const suffix = '"}';
    const padLen = MAX_STDIN - prefix.length - suffix.length;
    const payload = prefix + 'A'.repeat(padLen) + suffix;
    assert.strictEqual(Buffer.byteLength(payload, 'utf8'), MAX_STDIN, 'test payload must be exactly at the cap');
    const result = readViaSubprocess(payload);
    assert.strictEqual(result.truncated, false, 'a boundary-exact payload with nothing discarded must not be flagged truncated');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.hasValue, true);
  })) passed++; else failed++;

  if (test('a payload one byte over MAX_STDIN is marked truncated', () => {
    const prefix = '{"padding":"';
    const suffix = 'X"}';
    const padLen = MAX_STDIN - prefix.length - suffix.length + 1;
    const payload = prefix + 'A'.repeat(padLen) + suffix;
    assert.strictEqual(Buffer.byteLength(payload, 'utf8'), MAX_STDIN + 1, 'test payload must be exactly one byte over the cap');
    const result = readViaSubprocess(payload);
    assert.strictEqual(result.truncated, true);
  })) passed++; else failed++;

  if (test('a multibyte (emoji) payload is capped by real UTF-8 bytes, not UTF-16 code units', () => {
    // Each emoji is a surrogate pair: 2 UTF-16 code units but 4 UTF-8 bytes.
    // Before the fix, accumulating into a JS string and capping on
    // .length used code units, so this payload (600K units, under the old
    // buggy cap) sailed through even though it is 1.2MB of real bytes.
    const emoji = '\u{1F600}'.repeat(300000);
    const payload = JSON.stringify({ padding: emoji });
    const byteLength = Buffer.byteLength(payload, 'utf8');
    const codeUnitLength = payload.length;
    assert.ok(byteLength > MAX_STDIN, 'test payload must exceed the byte cap');
    assert.ok(codeUnitLength < MAX_STDIN, 'test payload must stay under the old (buggy) code-unit cap, or this test proves nothing');
    const result = readViaSubprocess(payload);
    assert.strictEqual(result.truncated, true, `expected truncated=true for a ${byteLength}-byte payload (cap ${MAX_STDIN}), got ${JSON.stringify(result)}`);
  })) passed++; else failed++;

  if (test('a small well-formed payload is read correctly, not truncated', () => {
    const result = readViaSubprocess(JSON.stringify({ hello: 'world' }));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.hasValue, true);
  })) passed++; else failed++;

  if (test('malformed (non-truncated) JSON fails open with ok:false, truncated:false', () => {
    const result = readViaSubprocess('{not valid json');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.truncated, false);
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
