'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  MAX_JOBS,
  parseJobsFlag,
  parseReportFlag,
  orderLongestFirst,
  privateEnv,
  runInPrivateEnv,
  didFail,
  runPool
} = require('../fixtures/run-jobs');
const { compareReports } = require('../fixtures/compare-reports');
const { removeDirWithRetries } = require('../fixtures/remove-dir');
const { FULL_INSTALL_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

const TESTS_DIR = path.join(__dirname, '..');
const FIXTURES = ['suite-env', 'harness-variables', 'subprocess-timeouts', 'run-durations', 'run-jobs', 'remove-dir', 'test-classifier'];

function writeMiniSuite(root) {
  const tests = path.join(root, 'tests');
  fs.mkdirSync(path.join(tests, 'fixtures'), { recursive: true });
  fs.copyFileSync(path.join(TESTS_DIR, 'run-all.js'), path.join(tests, 'run-all.js'));
  for (const name of FIXTURES) {
    fs.copyFileSync(path.join(TESTS_DIR, 'fixtures', `${name}.js`), path.join(tests, 'fixtures', `${name}.js`));
  }
  fs.writeFileSync(path.join(tests, 'serial-manifest.json'), JSON.stringify({ files: [] }));
  const write = (name, body) => fs.writeFileSync(path.join(tests, name), body);
  write('a.test.js', "console.log('Results: Passed: 3, Failed: 0');\n");
  write('b.test.js', "console.log('Results: Passed: 1, Failed: 1');\nprocess.exit(1);\n");
  write('c.test.js', "console.log('Results: Passed: 2, Failed: 0');\n");
  write('d.test.js', [
    "if (String(process.env.HOME || '').includes('egc-suite-job-')) {",
    "  console.log('Results: Passed: 0, Failed: 1');",
    '  process.exit(1);',
    '}',
    "console.log('Results: Passed: 4, Failed: 0');",
    ''
  ].join('\n'));
  return path.join(tests, 'run-all.js');
}

function runSuite(runAll, args, tmp) {
  return spawnSync(process.execPath, [runAll, ...args], {
    encoding: 'utf8',
    timeout: FULL_INSTALL_TIMEOUT_MS,
    env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp }
  });
}

(async () => {
  console.log('\n=== Testing run-jobs and compare-reports ===\n');

  await test('parseJobsFlag reads both spellings and returns null without the flag', () => {
    assert.strictEqual(parseJobsFlag(['--jobs', '4']), 4);
    assert.strictEqual(parseJobsFlag(['--jobs=8']), 8);
    assert.strictEqual(parseJobsFlag(['--durations', 'x.json']), null);
  });

  await test('parseJobsFlag rejects a missing, zero, fractional or oversized value', () => {
    for (const argv of [['--jobs'], ['--jobs', '0'], ['--jobs=2.5'], ['--jobs', 'many'], ['--jobs', String(MAX_JOBS + 1)]]) {
      assert.throws(() => parseJobsFlag(argv), /--jobs needs a whole number/, argv.join(' '));
    }
  });

  await test('parseJobsFlag falls back to EGC_TEST_JOBS and lets the flag win', () => {
    assert.strictEqual(parseJobsFlag([], { EGC_TEST_JOBS: '4' }), 4);
    assert.strictEqual(parseJobsFlag(['--jobs', '2'], { EGC_TEST_JOBS: '4' }), 2);
    assert.strictEqual(parseJobsFlag([], {}), null);
  });

  await test('parseJobsFlag treats an empty EGC_TEST_JOBS as unset and names a bad one', () => {
    assert.strictEqual(parseJobsFlag([], { EGC_TEST_JOBS: '' }), null);
    for (const value of ['0', '2.5', 'many', String(MAX_JOBS + 1)]) {
      assert.throws(() => parseJobsFlag([], { EGC_TEST_JOBS: value }), /EGC_TEST_JOBS needs a whole number/, value);
    }
  });

  await test('parseReportFlag needs a path', () => {
    assert.strictEqual(parseReportFlag(['--report', 'r.json']), 'r.json');
    assert.strictEqual(parseReportFlag([]), null);
    assert.throws(() => parseReportFlag(['--report']), /--report needs a file path/);
    assert.throws(() => parseReportFlag(['--report', '--jobs']), /--report needs a file path/);
  });

  await test('orderLongestFirst puts the biggest file first and breaks ties by name', () => {
    const sizes = { 'a.test.js': 10, 'b.test.js': 30, 'c.test.js': 30, 'd.test.js': 5 };
    assert.deepStrictEqual(
      orderLongestFirst(Object.keys(sizes), file => sizes[file]),
      ['b.test.js', 'c.test.js', 'a.test.js', 'd.test.js']
    );
  });

  await test('runPool keeps the input order and never runs more than N at once', async () => {
    let running = 0;
    let peak = 0;
    const items = [40, 5, 30, 1, 20, 10];
    const results = await runPool(items, 3, async (ms, index) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, ms));
      running--;
      return `${index}:${ms}`;
    });
    assert.deepStrictEqual(results, ['0:40', '1:5', '2:30', '3:1', '4:20', '5:10']);
    assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
  });

  await test('runPool with no items resolves to an empty list', async () => {
    assert.deepStrictEqual(await runPool([], 4, async () => 1), []);
  });

  await test('privateEnv gives a private home and temp folder and leaves EGC_DIR unset', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-run-jobs-env-'));
    try {
      const env = privateEnv({ KEEP: '1' }, dir);
      assert.strictEqual(env.KEEP, '1');
      assert.strictEqual(env.HOME, path.join(dir, 'home'));
      assert.strictEqual(env.USERPROFILE, env.HOME);
      assert.strictEqual(env.TMPDIR, path.join(dir, 'tmp'));
      assert.strictEqual(env.TEMP, env.TMPDIR);
      assert.strictEqual(env.TMP, env.TMPDIR);
      assert.ok(fs.statSync(env.HOME).isDirectory() && fs.statSync(env.TMPDIR).isDirectory());
      assert.ok(!('EGC_DIR' in env));
    } finally {
      removeDirWithRetries(dir);
    }
  });

  await test('runInPrivateEnv runs the file in a home of its own and removes it afterwards', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-run-jobs-file-'));
    try {
      const script = path.join(dir, 'where.js');
      fs.writeFileSync(script, "process.stdout.write(process.env.HOME + '|' + process.env.TMPDIR);\n");
      const result = await runInPrivateEnv(script, { ...process.env });
      assert.strictEqual(didFail(result), false);
      const [home, tmp] = result.stdout.split('|');
      assert.ok(home.includes('egc-suite-job-') && tmp.includes('egc-suite-job-'));
      assert.ok(!fs.existsSync(path.dirname(home)), 'the private folder is gone');
    } finally {
      removeDirWithRetries(dir);
    }
  });

  await test('didFail is true for a non-zero status and for a start error', () => {
    assert.strictEqual(didFail({ status: 0, error: null }), false);
    assert.strictEqual(didFail({ status: 1, error: null }), true);
    assert.strictEqual(didFail({ status: null, error: new Error('spawn') }), true);
  });

  await test('compareReports accepts identical runs and lists every kind of difference', () => {
    const file = (name, passedCount, failedCount, ok = true) => ({ file: name, passed: passedCount, failed: failedCount, ok });
    const base = { mode: 'serial', totals: { passed: 5, failed: 1 }, files: [file('a', 3, 0), file('b', 2, 1, false)] };
    assert.deepStrictEqual(compareReports(base, JSON.parse(JSON.stringify(base))), []);

    const other = { mode: 'parallel', totals: { passed: 4, failed: 1 }, files: [file('a', 2, 0), file('c', 2, 1, false)] };
    const differences = compareReports(base, other);
    assert.ok(differences.some(line => line.startsWith('a: passed 3/2')), differences.join('\n'));
    assert.ok(differences.some(line => line === 'b: missing from the second run'));
    assert.ok(differences.some(line => line === 'c: missing from the first run'));
    assert.ok(differences.some(line => line.startsWith('totals: passed 5/4')));
  });

  await test('a serial and a parallel run of the same suite are equivalent, and a load-only failure is confirmed alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-run-jobs-suite-'));
    try {
      const runAll = writeMiniSuite(root);
      const serialReport = path.join(root, 'serial.json');
      const parallelReport = path.join(root, 'parallel.json');

      const serial = runSuite(runAll, ['--report', serialReport], root);
      const parallel = runSuite(runAll, ['--jobs', '2', '--report', parallelReport], root);

      assert.strictEqual(serial.status, 1, serial.stderr);
      assert.strictEqual(parallel.status, 1, parallel.stderr);
      assert.ok(/Total Tests:\s+11/.test(serial.stdout) && /Total Tests:\s+11/.test(parallel.stdout), parallel.stdout);
      assert.ok(parallel.stdout.includes('Parallel run: 2 workers, 4 files in the pool, 0 serial'), parallel.stdout);
      assert.ok(parallel.stdout.includes('d.test.js failed in the pool and passed alone'), parallel.stdout);
      assert.ok(parallel.stdout.includes('b.test.js failed in the pool and failed alone too'), parallel.stdout);

      const order = text => [...text.matchAll(/━━━ Running (\S+) ━━━/g)].map(match => match[1]);
      assert.deepStrictEqual(order(parallel.stdout), order(serial.stdout));

      const compared = spawnSync(process.execPath, [path.join(TESTS_DIR, 'fixtures', 'compare-reports.js'), serialReport, parallelReport], { encoding: 'utf8' });
      assert.strictEqual(compared.status, 0, compared.stdout);
      assert.ok(compared.stdout.startsWith('Equivalent: 4 files'));
    } finally {
      removeDirWithRetries(root);
    }
  });

  await test('the plain command prints no parallel section and a bad --jobs value is rejected', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-run-jobs-plain-'));
    try {
      const runAll = writeMiniSuite(root);
      const plain = runSuite(runAll, [], root);
      assert.ok(!plain.stdout.includes('Parallel run'));
      const bad = runSuite(runAll, ['--jobs', '0'], root);
      assert.notStrictEqual(bad.status, 0);
      assert.ok(/--jobs needs a whole number/.test(bad.stderr), bad.stderr);
    } finally {
      removeDirWithRetries(root);
    }
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
