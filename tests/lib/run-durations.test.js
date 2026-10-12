'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  DEFAULT_WORKERS,
  estimateWallMs,
  summarizeDurations,
  formatDurationReport,
  parseDurationsFlag
} = require('../fixtures/run-durations');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

console.log('\n=== Testing run-durations ===\n');

test('estimateWallMs spreads the longest files first across the workers', () => {
  const durations = [6, 5, 4, 3, 2, 1].map(ms => ({ ms }));
  assert.strictEqual(estimateWallMs(durations, 2), 11);
});

test('estimateWallMs never goes below the longest single file', () => {
  const durations = [{ ms: 100 }, { ms: 1 }, { ms: 1 }];
  assert.strictEqual(estimateWallMs(durations, 8), 100);
});

test('estimateWallMs with one worker equals the serial total', () => {
  const durations = [{ ms: 5 }, { ms: 7 }, { ms: 3 }];
  assert.strictEqual(estimateWallMs(durations, 1), 15);
});

test('estimateWallMs of an empty list is zero', () => {
  assert.strictEqual(estimateWallMs([], 4), 0);
});

test('summarizeDurations names the longest file and totals the time', () => {
  const summary = summarizeDurations([
    { file: 'a.test.js', ms: 400 },
    { file: 'b.test.js', ms: 1600 },
    { file: 'c.test.js', ms: 200 }
  ]);
  assert.strictEqual(summary.files, 3);
  assert.strictEqual(summary.totalMs, 2200);
  assert.strictEqual(summary.longest.file, 'b.test.js');
  assert.strictEqual(summary.workers, DEFAULT_WORKERS);
  assert.strictEqual(summary.estimatedWallMs, 1600);
});

test('summarizeDurations falls back to the default workers on a bad count', () => {
  assert.strictEqual(summarizeDurations([{ file: 'a', ms: 1 }], 0).workers, DEFAULT_WORKERS);
  assert.strictEqual(summarizeDurations([{ file: 'a', ms: 1 }], 2.5).workers, DEFAULT_WORKERS);
});

test('formatDurationReport prints the longest file and the estimate', () => {
  const report = formatDurationReport(
    summarizeDurations([{ file: 'slow.test.js', ms: 2500 }, { file: 'fast.test.js', ms: 500 }])
  );
  assert.ok(report.includes('2 files, 3.0s in total'), report);
  assert.ok(report.includes('slow.test.js (2.5s)'), report);
  assert.ok(report.includes('8 workers would need: 2.5s'), report);
});

test('formatDurationReport handles a run with no timed file', () => {
  assert.strictEqual(formatDurationReport(summarizeDurations([])), 'Durations: no test file was timed.');
});

test('parseDurationsFlag returns null when the flag is absent', () => {
  assert.strictEqual(parseDurationsFlag(['--other']), null);
});

test('parseDurationsFlag reads the separate and the equals forms', () => {
  assert.strictEqual(parseDurationsFlag(['--durations', 'out.json']), 'out.json');
  assert.strictEqual(parseDurationsFlag(['--durations=out.json']), 'out.json');
});

test('parseDurationsFlag rejects a missing path', () => {
  assert.throws(() => parseDurationsFlag(['--durations']), /needs a file path/);
  assert.throws(() => parseDurationsFlag(['--durations', '--other']), /needs a file path/);
  assert.throws(() => parseDurationsFlag(['--durations=']), /needs a file path/);
});

test('run-all rejects --durations without a path before running any test', () => {
  const result = spawnSync('node', [path.join(__dirname, '..', 'run-all.js'), '--durations'], {
    encoding: 'utf8'
  });
  assert.notStrictEqual(result.status, 0);
  assert.ok((result.stderr || '').includes('needs a file path'), result.stderr);
  assert.ok(!(result.stdout || '').includes('Running'), 'no test file should have started');
});

test('a run with --durations writes the report and times every file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-durations-'));
  try {
    const testsDir = path.join(dir, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });
    for (const name of ['a.test.js', 'b.test.js']) {
      fs.writeFileSync(path.join(testsDir, name), "console.log('Passed: 1\\nFailed: 0');\n");
    }
    const fixtures = path.join(__dirname, '..', 'fixtures');
    let source = fs.readFileSync(path.join(__dirname, '..', 'run-all.js'), 'utf8');
    source = source.replace('const testsDir = __dirname;', `const testsDir = ${JSON.stringify(testsDir)};`);
    source = source.replace("require('./fixtures/suite-env')", `require(${JSON.stringify(path.join(fixtures, 'suite-env'))})`);
    source = source.replace("require('./fixtures/run-durations')", `require(${JSON.stringify(path.join(fixtures, 'run-durations'))})`);
    const wrapper = path.join(dir, 'run-all-wrapper.js');
    fs.writeFileSync(wrapper, source);
    const file = path.join(dir, 'durations.json');

    const result = spawnSync('node', [wrapper, '--durations', file], { encoding: 'utf8', timeout: 20000 });

    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes('Per-file durations written to'), result.stdout);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(Object.keys(parsed).sort(), ['files', 'summary']);
    assert.deepStrictEqual(parsed.files.map(entry => entry.file), ['a.test.js', 'b.test.js']);
    assert.ok(parsed.files.every(entry => Number.isInteger(entry.ms) && entry.ms >= 0));
    assert.strictEqual(parsed.summary.files, 2);
    assert.deepStrictEqual(Object.keys(parsed.summary).sort(), [
      'estimatedWallMs',
      'files',
      'longest',
      'totalMs',
      'workers'
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
