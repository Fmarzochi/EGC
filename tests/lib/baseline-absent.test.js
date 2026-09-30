/**
 * The baseline-absent helper (tests/lib/baseline-absent.js) may turn a test
 * failure into a SKIP only when the surface the test asserts on is truly
 * absent from the checkout. A failure that names a file which exists, or an
 * assertion that merely matches a listed phrase, is a real failure and must
 * stay one.
 *
 * Run with: node tests/lib/baseline-absent.test.js
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { isBaselineAbsentError, BASELINE_ABSENT_PATHS } = require('./baseline-absent');

const REPO_ROOT = path.join(__dirname, '..', '..');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
  }
}

function enoent(file) {
  const err = new Error(`ENOENT: no such file or directory, open '${file}'`);
  err.code = 'ENOENT';
  err.path = file;
  return err;
}

console.log('\n=== Testing the baseline-absent helper ===\n');

test('an ENOENT for a listed path that is really missing from the checkout is baseline-absent', () => {
  const missing = BASELINE_ABSENT_PATHS.find(p => !fs.existsSync(path.join(REPO_ROOT, p)));
  assert.ok(missing, 'the list must still name at least one path that is absent, or this test has nothing to prove');
  assert.strictEqual(isBaselineAbsentError(enoent(path.join(REPO_ROOT, missing)), 'any test'), true);
});

test('an ENOENT for a listed path that exists in the checkout is a real failure', () => {
  // A path on the list that is present today: the list is stale for it, and
  // a test that cannot find it is broken for another reason.
  const present = BASELINE_ABSENT_PATHS.find(p => fs.existsSync(path.join(REPO_ROOT, p)));
  if (!present) {
    console.log('    (no listed path exists in this checkout; nothing to prove here)');
    return;
  }
  assert.strictEqual(isBaselineAbsentError(enoent(path.join(REPO_ROOT, present)), 'any test'), false);
});

test('an error that only mentions a listed path in its message, without ENOENT, is a real failure', () => {
  const err = new Error('Expected scripts/list-installed.js to print a table, got nothing');
  assert.strictEqual(isBaselineAbsentError(err, 'emits JSON for discovered install-state records'), false);
});

test('an assertion failure is never turned into a skip by its message or by the test name', () => {
  const err = new assert.AssertionError({ message: 'README should surface a top-level install decision section', actual: false, expected: true });
  assert.strictEqual(isBaselineAbsentError(err, 'warns not to run the full installer after plugin install'), false);
});

test('an ENOENT for a path that is not on the list is a real failure', () => {
  assert.strictEqual(isBaselineAbsentError(enoent(path.join(REPO_ROOT, 'docs', 'no-such-file.md')), 'any test'), false);
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
