'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { removeDirWithRetries, RETRYABLE_REMOVE_CODES } = require('../fixtures/remove-dir');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

function busy(code) {
  const error = new Error(`${code}: resource busy or locked`);
  error.code = code;
  return error;
}

console.log('=== Testing the retrying removal of test directories ===\n');

test('removes a real directory and reports it gone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-remove-dir-'));
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
  assert.strictEqual(removeDirWithRetries(dir), true);
  assert.ok(!fs.existsSync(dir), 'the directory is gone');
});

test('a directory that no longer exists is not an error', () => {
  const dir = path.join(os.tmpdir(), 'egc-remove-dir-missing-' + process.pid);
  assert.strictEqual(removeDirWithRetries(dir), true);
});

test('retries a busy directory with a growing delay and succeeds once the handle is released', () => {
  let calls = 0;
  const rm = () => {
    calls++;
    if (calls < 3) throw busy('EBUSY');
  };
  const sleeps = [];
  const result = removeDirWithRetries('held-by-the-system', { rm, sleep: (ms) => sleeps.push(ms), delayMs: 10, attempts: 5 });
  assert.strictEqual(result, true);
  assert.strictEqual(calls, 3, 'two failures and one success');
  assert.deepStrictEqual(sleeps, [10, 20], 'the delay grows with the attempt');
});

test('a directory the system still holds after every attempt is left behind with a warning, not a failure', () => {
  const rm = () => { throw busy('EBUSY'); };
  const warnings = [];
  const result = removeDirWithRetries('D:\\work\\egc-held', { rm, sleep: () => {}, attempts: 4, warn: (message) => warnings.push(message) });
  assert.strictEqual(result, false);
  assert.strictEqual(warnings.length, 1, 'one warning');
  assert.ok(warnings[0].includes('EBUSY'), warnings[0]);
  assert.ok(warnings[0].includes('D:\\work\\egc-held'), warnings[0]);
  assert.ok(warnings[0].includes('4 attempts'), warnings[0]);
});

test('EPERM and ENOTEMPTY are retried like EBUSY', () => {
  for (const code of ['EPERM', 'ENOTEMPTY']) {
    assert.ok(RETRYABLE_REMOVE_CODES.has(code), `${code} is retryable`);
    let calls = 0;
    const rm = () => {
      calls++;
      if (calls === 1) throw busy(code);
    };
    assert.strictEqual(removeDirWithRetries('held-by-the-system', { rm, sleep: () => {}, attempts: 3 }), true);
    assert.strictEqual(calls, 2);
  }
});

test('an error that is not a handle race is thrown at once, without retries', () => {
  let calls = 0;
  const rm = () => {
    calls++;
    throw busy('EACCES');
  };
  assert.throws(() => removeDirWithRetries('denied-dir', { rm, sleep: () => {}, attempts: 5 }), /EACCES/);
  assert.strictEqual(calls, 1);
});

test('the default budget covers more than one second of a held handle', () => {
  const sleeps = [];
  const rm = () => { throw busy('EBUSY'); };
  removeDirWithRetries('held-by-the-system', { rm, sleep: (ms) => sleeps.push(ms), warn: () => {} });
  const total = sleeps.reduce((sum, ms) => sum + ms, 0);
  assert.ok(total >= 5000, `the retries wait at least five seconds in total, got ${total} ms`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
