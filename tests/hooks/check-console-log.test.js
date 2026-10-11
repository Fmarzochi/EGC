'use strict';

/**
 * Tests for scripts/hooks/check-console-log.js (#1704): the directory
 * exclusions match a whole path segment with either separator, and the
 * module can be required without starting its stdin reader.
 *
 * Run with: node tests/hooks/check-console-log.test.js
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const script = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'check-console-log.js');
const { isExcluded } = require(script);

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

let passed = 0;
let failed = 0;
const tally = ok => { if (ok) passed++; else failed++; };

console.log('\n=== Testing check-console-log.js ===\n');

tally(test('scripts/, __tests__/ and __mocks__/ are excluded with forward slashes and with backslashes', () => {
  assert.strictEqual(isExcluded('scripts/hooks/a.js'), true);
  assert.strictEqual(isExcluded('scripts\\hooks\\a.js'), true);
  assert.strictEqual(isExcluded('src\\__tests__\\a.js'), true);
  assert.strictEqual(isExcluded('C:\\repo\\__mocks__\\a.js'), true);
  assert.strictEqual(isExcluded('packages/app/scripts/build.js'), true);
}));

tally(test('a directory that merely ends in scripts is checked, and so is a plain source file', () => {
  assert.strictEqual(isExcluded('src/myscripts/a.js'), false);
  assert.strictEqual(isExcluded('src/app.js'), false);
  assert.strictEqual(isExcluded('src/app.test.js'), true, 'test files stay excluded');
}));

tally(test('requiring the module does not start the stdin reader', () => {
  // A data listener would have put stdin in flowing mode; untouched it stays paused.
  assert.notStrictEqual(process.stdin.readableFlowing, true);
  assert.strictEqual(process.stdin.listenerCount('data'), 0);
}));

tally(test('run as a script it still passes its input through', () => {
  const result = spawnSync(process.execPath, [script], { input: '{"x":1}', encoding: 'utf8', timeout: CLI_TIMEOUT_MS, cwd: os.tmpdir() });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, '{"x":1}');
}));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
