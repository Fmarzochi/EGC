'use strict';
// Concurrent-write regression coverage for the Token Crusher ledger.
// record()/readAll() operate on ~/.egc/metrics/crusher.jsonl, a file every
// EGC process on the machine can append to at once (hooks firing in
// parallel terminals, background agents, etc). fs.appendFileSync is a
// single O_APPEND write() per call, which POSIX and NTFS both keep atomic
// per-call -- but that guarantee is only real if every call really does
// stay a single small write, and nothing upstream ever batches multiple
// entries into one appendFileSync call. This spawns real separate
// processes (not Promise.all in one process, which can't exercise true
// concurrency: record() is synchronous, so same-process "concurrent" calls
// would just run sequentially and prove nothing) writing to the same file
// at once and asserts nothing was lost or interleaved into invalid JSON.
//
// Flagged by @Maqbool61 on issue #1117 as a gap in PR #1118's test coverage.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const METRICS_PATH = path.join(__dirname, '..', 'scripts', 'lib', 'crusher', 'metrics.js');
const N = Math.max(4, Number.parseInt(process.env.EGC_METRICS_CTEST_PROCS || '8', 10) || 8);

function test(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
function run(name, fn) { if (test(name, fn)) passed++; else failed++; }

async function runAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function makeFakeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-crusher-metrics-test-'));
}

// A single-line child script, written to a real file (not spawned via
// `node -e`) so it reads like any other script in this repo. Requires
// metrics.js directly and appends one entry; HOME/USERPROFILE (set on the
// spawned process' env, not here) determine where metricsFilePath() lands.
const CHILD_SCRIPT = `
const { record } = require(${JSON.stringify(METRICS_PATH)});
const index = Number(process.argv[2]);
record({
  cmd: 'echo ' + index,
  kind: 'echo',
  bytesIn: 100,
  bytesOut: 50,
  tokensSaved: index % 3 === 0 ? 0 : index,
});
`;

function spawnChild(childScriptPath, index, homeDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScriptPath, String(index)], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`child ${index} exited ${code}`))));
  });
}

async function testConcurrentWritesAllLandAsParseableLines() {
  const homeDir = makeFakeHome();
  try {
    const childScriptPath = path.join(homeDir, 'record-one.js');
    fs.writeFileSync(childScriptPath, CHILD_SCRIPT);

    await Promise.all(
      Array.from({ length: N }, (_, i) => spawnChild(childScriptPath, i, homeDir))
    );

    const ledgerPath = path.join(homeDir, '.egc', 'metrics', 'crusher.jsonl');
    const raw = fs.readFileSync(ledgerPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);

    assert.strictEqual(lines.length, N, `expected ${N} lines, got ${lines.length} (lost or merged writes)`);

    const parsed = lines.map(line => JSON.parse(line)); // throws on any torn/interleaved line
    const indices = parsed.map(entry => Number(entry.cmd.replace('echo ', ''))).sort((a, b) => a - b);
    assert.deepStrictEqual(indices, Array.from({ length: N }, (_, i) => i), 'every process index must appear exactly once');

    const zeroSavingsEntries = parsed.filter(e => e.tokensSaved === 0);
    assert.ok(zeroSavingsEntries.length > 0, 'test setup should include at least one zero-savings entry');
  } finally {
    // Cleanup must run even when an assertion or child spawn fails above,
    // or a failing run leaks a temp dir into os.tmpdir() on every retry
    // (cubic review, PR #1125).
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

async function main() {
  await runAsync(`${N} concurrent cross-process record() calls all land as parseable, non-interleaved lines`, testConcurrentWritesAllLandAsParseableLines);

  run('readAll returns [] for a home directory with no ledger yet', () => {
    const homeDir = makeFakeHome();
    const originalHomedir = os.homedir;
    os.homedir = () => homeDir;
    try {
      const { readAll } = require(METRICS_PATH);
      assert.deepStrictEqual(readAll(), []);
    } finally {
      os.homedir = originalHomedir;
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
