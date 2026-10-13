'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  scanSource,
  normalizeEntries,
  loadManifest,
  classifyTestFiles,
  discoverTestFiles,
  formatClassification
} = require('../fixtures/test-classifier');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

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

const TESTS_DIR = path.join(__dirname, '..');
const readTest = file => fs.readFileSync(path.join(TESTS_DIR, file), 'utf8');

console.log('\n=== Testing test-classifier ===\n');

test('scanSource flags process.chdir', () => {
  assert.deepStrictEqual(scanSource("process.chdir(dir);\n"), ['chdir']);
});

test('scanSource flags a fixed port and lets port 0 pass', () => {
  assert.deepStrictEqual(scanSource("server.listen(4000, () => {});\n"), ['fixed-port']);
  assert.deepStrictEqual(scanSource("const port = 18801;\n"), ['fixed-port']);
  assert.deepStrictEqual(scanSource("server.listen(0, '127.0.0.1', done);\n"), []);
});

test('scanSource flags a fixed temp name but not mkdtemp or a unique name', () => {
  assert.deepStrictEqual(scanSource("const f = path.join(os.tmpdir(), 'egc-shared');\n"), ['fixed-temp-name']);
  assert.deepStrictEqual(scanSource("fs.mkdtempSync(path.join(os.tmpdir(), 'egc-x-'));\n"), []);
  assert.deepStrictEqual(scanSource("path.join(os.tmpdir(), `egc-x-${process.pid}`);\n"), []);
});

test('scanSource reports every hazard once, in a stable order', () => {
  const source = "process.chdir(a);\nprocess.chdir(b);\nsrv.listen(8080);\npath.join(os.tmpdir(), 'fixed');\n";
  assert.deepStrictEqual(scanSource(source), ['chdir', 'fixed-port', 'fixed-temp-name']);
});

test('a file with no hazard is independent and says nothing about why', () => {
  const [result] = classifyTestFiles(['a.test.js'], () => 'assert.ok(true);\n', new Map());
  assert.strictEqual(result.serial, false);
  assert.strictEqual(result.decidedBy, 'none');
  assert.deepStrictEqual(result.reasons, []);
});

test('the scan alone sends a file with a hazard to serial', () => {
  const [result] = classifyTestFiles(['a.test.js'], () => 'srv.listen(3000);\n', new Map());
  assert.strictEqual(result.serial, true);
  assert.strictEqual(result.decidedBy, 'scan');
  assert.deepStrictEqual(result.reasons, ['fixed-port']);
});

test('the manifest pins a clean file to serial with its reason', () => {
  const manifest = normalizeEntries([{ file: 'a.test.js', mode: 'serial', reason: 'timing' }]);
  const [result] = classifyTestFiles(['a.test.js'], () => 'assert.ok(true);\n', manifest);
  assert.strictEqual(result.serial, true);
  assert.strictEqual(result.decidedBy, 'manifest');
  assert.deepStrictEqual(result.reasons, ['timing']);
});

test('the manifest overrides the scan when it frees a file', () => {
  const manifest = normalizeEntries([{ file: 'a.test.js', mode: 'parallel', reason: 'never written' }]);
  const [result] = classifyTestFiles(['a.test.js'], () => "path.join(os.tmpdir(), 'fixed');\n", manifest);
  assert.strictEqual(result.serial, false);
  assert.strictEqual(result.decidedBy, 'manifest');
  assert.deepStrictEqual(result.hazards, ['fixed-temp-name']);
});

test('the manifest refuses an entry without a reason, a bad mode or a bad path', () => {
  assert.throws(() => normalizeEntries([{ file: 'a.test.js', mode: 'serial' }]), /needs a "reason"/);
  assert.throws(() => normalizeEntries([{ file: 'a.test.js', mode: 'slow', reason: 'x' }]), /"mode"/);
  assert.throws(() => normalizeEntries([{ file: 'a\\b.test.js', mode: 'serial', reason: 'x' }]), /forward slashes/);
  assert.throws(() => normalizeEntries([{ file: '/abs/a.test.js', mode: 'serial', reason: 'x' }]), /relative path/);
  assert.throws(() => normalizeEntries({}), /must be an array/);
});

test('the manifest refuses a file listed twice', () => {
  const entry = { file: 'a.test.js', mode: 'serial', reason: 'x' };
  assert.throws(() => normalizeEntries([entry, entry]), /listed twice/);
});

test('an entry for a file that is not a test file is refused', () => {
  const manifest = normalizeEntries([{ file: 'gone.test.js', mode: 'serial', reason: 'x' }]);
  assert.throws(() => classifyTestFiles(['a.test.js'], () => '', manifest), /gone\.test\.js is not a test file/);
});

test('formatClassification lists the serial files with who decided and why', () => {
  const manifest = normalizeEntries([{ file: 'b.test.js', mode: 'serial', reason: 'timing' }]);
  const sources = { 'a.test.js': 'srv.listen(3000);\n', 'b.test.js': '', 'c.test.js': '' };
  const report = formatClassification(classifyTestFiles(Object.keys(sources), file => sources[file], manifest));
  assert.ok(report.startsWith('Test files: 3, independent: 1, serial: 2'));
  assert.ok(report.includes('serial  a.test.js  [scan] fixed-port'));
  assert.ok(report.includes('serial  b.test.js  [manifest] timing'));
});

test('known files of this repository land where the scan and the manifest put them', () => {
  const files = discoverTestFiles(TESTS_DIR);
  const results = new Map(classifyTestFiles(files, readTest, loadManifest()).map(result => [result.file, result]));
  assert.strictEqual(results.get('lib/state-store.test.js').serial, true, 'process.chdir');
  assert.strictEqual(results.get('ci/catalog.test.js').serial, false, 'mkdtemp only');
  assert.strictEqual(results.get('hooks/hooks.test.js').decidedBy, 'manifest');
  assert.strictEqual(results.get('lib/state-overview.test.js').serial, false, 'freed by the manifest');
});

test('the checked-in manifest only names test files that exist', () => {
  const files = discoverTestFiles(TESTS_DIR);
  assert.ok(files.length > 300, 'the walk finds the suite');
  assert.doesNotThrow(() => classifyTestFiles(files, readTest, loadManifest()));
});

test('discoverTestFiles uses forward slashes relative to tests/', () => {
  const files = discoverTestFiles(TESTS_DIR);
  assert.ok(files.includes('lib/test-classifier.test.js'));
  assert.ok(files.every(file => !file.includes('\\') && file.endsWith('.test.js')));
});

test('running the module prints the report and exits 0', () => {
  const result = spawnSync(process.execPath, [path.join(TESTS_DIR, 'fixtures', 'test-classifier.js')], {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env: { ...process.env, TMPDIR: os.tmpdir() }
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(/^Test files: \d+, independent: \d+, serial: \d+/.test(result.stdout));
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
