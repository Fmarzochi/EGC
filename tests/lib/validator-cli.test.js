/**
 * Tests for scripts/lib/validator-cli.js -- the shared CLI runner boilerplate
 * (skip-if-missing + finish-with-exit-code) extracted from nine of the
 * scripts/ci/validate-*.js scripts (EGC-539 audit, scripts/ finding).
 *
 * skipIfMissing() and finishValidation() call process.exit() on some code
 * paths, so those paths are exercised via a child process (like
 * tests/ci/validators.test.js does for the validators themselves); the
 * non-exiting paths are safe to call in-process.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const { skipIfMissing, finishValidation } = require('../../scripts/lib/validator-cli');
const { runSourceInChildProcess } = require('./run-source-in-child-process');

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

/**
 * Run a snippet of source that requires #lib/validator-cli in a child
 * process, so process.exit() calls inside skipIfMissing/finishValidation
 * don't kill the test runner itself.
 * @param {string} body - source appended after the require line
 * @returns {{code: number, stdout: string, stderr: string}}
 */
function runInChildProcess(body) {
  const source = `const { skipIfMissing, finishValidation } = require('#lib/validator-cli');\n${body}`;
  return runSourceInChildProcess(source, { cwd: repoRoot, filePrefix: '.tmp-validator-cli-test-' });
}

function runTests() {
  console.log('\n=== Testing scripts/lib/validator-cli.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('skipIfMissing returns without exiting when the given path exists', () => {
    let threw = false;
    try {
      skipIfMissing(__filename, 'should not print');
    } catch (_err) {
      threw = true;
    }
    assert.strictEqual(threw, false, 'skipIfMissing must not throw when the path exists');
  })) passed++; else failed++;

  if (test('skipIfMissing returns without exiting when every path in an array exists', () => {
    let threw = false;
    try {
      skipIfMissing([__filename, repoRoot], 'should not print');
    } catch (_err) {
      threw = true;
    }
    assert.strictEqual(threw, false, 'skipIfMissing must not throw when all paths exist');
  })) passed++; else failed++;

  // Deterministic child-process counterpart to the two in-process cases
  // above (cubic review, EGC-539 PR #1151): those only prove skipIfMissing
  // doesn't throw when called directly, but if a regression ever made it
  // call process.exit() on the exists-path too, it would silently kill this
  // whole test runner mid-suite -- reporting success with zero tests run,
  // since finishValidation exits 0 -- rather than failing loudly. Running
  // the same call in a child process makes that failure mode visible: a
  // stray exit shows up as UNREACHABLE never printing.
  if (test('skipIfMissing (child process): does not exit when the given path exists', () => {
    const result = runInChildProcess(
      `skipIfMissing(${JSON.stringify(__filename)}, 'should not print');\nconsole.log('REACHED');`
    );
    assert.strictEqual(result.code, 0, `Expected exit 0, got ${result.code}: ${result.stderr}`);
    assert.ok(!result.stdout.includes('should not print'), 'skipIfMissing must not print when the path exists');
    assert.ok(result.stdout.includes('REACHED'), 'code after skipIfMissing must still run when the path exists');
  })) passed++; else failed++;

  if (test('skipIfMissing prints the message and exits 0 when the path is missing', () => {
    const missing = path.join(os.tmpdir(), `validator-cli-test-missing-${Date.now()}`);
    const result = runInChildProcess(`skipIfMissing(${JSON.stringify(missing)}, 'skip message here');\nconsole.log('UNREACHABLE');`);
    assert.strictEqual(result.code, 0, `Expected exit 0, got ${result.code}: ${result.stderr}`);
    assert.ok(result.stdout.includes('skip message here'), `Expected skip message in stdout, got: ${result.stdout}`);
    assert.ok(!result.stdout.includes('UNREACHABLE'), 'Code after skipIfMissing must not run');
  })) passed++; else failed++;

  if (test('skipIfMissing exits 0 when any path in an array is missing (all-must-exist semantics)', () => {
    const missing = path.join(os.tmpdir(), `validator-cli-test-missing-${Date.now()}`);
    const result = runInChildProcess(
      `skipIfMissing([${JSON.stringify(__filename)}, ${JSON.stringify(missing)}], 'partial skip');\nconsole.log('UNREACHABLE');`
    );
    assert.strictEqual(result.code, 0, `Expected exit 0, got ${result.code}: ${result.stderr}`);
    assert.ok(result.stdout.includes('partial skip'));
    assert.ok(!result.stdout.includes('UNREACHABLE'));
  })) passed++; else failed++;

  if (test('finishValidation prints the success message and does not exit when hasErrors is false', () => {
    let threw = false;
    try {
      finishValidation(false, 'all good');
    } catch (_err) {
      threw = true;
    }
    assert.strictEqual(threw, false, 'finishValidation must not throw when hasErrors is false');
  })) passed++; else failed++;

  if (test('finishValidation exits 1 without printing the success message when hasErrors is true', () => {
    const result = runInChildProcess(`finishValidation(true, 'should not print');\nconsole.log('UNREACHABLE');`);
    assert.strictEqual(result.code, 1, `Expected exit 1, got ${result.code}: ${result.stderr}`);
    assert.ok(!result.stdout.includes('should not print'), 'Success message must not print when hasErrors is true');
    assert.ok(!result.stdout.includes('UNREACHABLE'), 'Code after finishValidation must not run');
  })) passed++; else failed++;

  // Deterministic child-process counterpart to the in-process case above
  // (cubic review, EGC-539 PR #1151): an in-process-only happy-path
  // assertion can't tell the difference between "never exits" and "the test
  // process happened to survive" -- if this branch ever regressed into
  // calling process.exit(), it would silently kill the whole suite mid-run
  // (finishValidation's own exit(0) makes that look like success with fewer
  // tests, not a failure) instead of failing loudly. Asserting REACHED
  // printed makes that failure mode visible.
  if (test('finishValidation exits 0 and prints the success message when hasErrors is false (child process)', () => {
    const result = runInChildProcess(`finishValidation(false, 'validated N things');\nconsole.log('REACHED');`);
    assert.strictEqual(result.code, 0, `Expected exit 0, got ${result.code}: ${result.stderr}`);
    assert.ok(result.stdout.includes('validated N things'));
    assert.ok(result.stdout.includes('REACHED'), 'code after finishValidation must still run when hasErrors is false');
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
