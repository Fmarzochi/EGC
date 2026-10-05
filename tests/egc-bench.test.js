'use strict';
/**
 * The benchmark harness: metric definitions, argument parsing, the task file
 * format, and one end-to-end run against the built guardian when it exists.
 *
 * Run with: node tests/egc-bench.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bench = path.join(__dirname, '..', 'scripts', 'bench');
const { recallAtK, reciprocalRank, percentile, estimateTokens, mean } = require(path.join(bench, 'metrics.js'));
const { parse, loadTasks, summarise } = require(path.join(bench, 'run.js'));

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

run('recall@k counts expected files found in the top k', () => {
  assert.strictEqual(recallAtK(['a', 'b', 'c'], ['a', 'c'], 2), 0.5);
  assert.strictEqual(recallAtK(['a', 'b', 'c'], ['a', 'c'], 3), 1);
  assert.strictEqual(recallAtK(['x'], [], 5), 1, 'nothing expected is trivially recalled');
});

run('reciprocal rank is 1/position of the first expected file, 0 when absent', () => {
  assert.strictEqual(reciprocalRank(['a', 'b', 'c'], ['b']), 0.5);
  assert.strictEqual(reciprocalRank(['a', 'b'], ['z']), 0);
  assert.strictEqual(reciprocalRank(['a', 'b'], ['a']), 1);
});

run('percentile uses nearest-rank and handles empty input', () => {
  assert.strictEqual(percentile([10, 20, 30, 40], 50), 20);
  assert.strictEqual(percentile([10, 20, 30, 40], 95), 40);
  assert.strictEqual(percentile([], 50), 0);
});

run('token estimate is characters over four, rounded up; mean of nothing is 0', () => {
  assert.strictEqual(estimateTokens(10), 3);
  assert.strictEqual(estimateTokens(0), 0);
  assert.strictEqual(mean([]), 0);
  assert.strictEqual(mean([1, 3]), 2);
});

run('parse applies defaults and rejects bad values', () => {
  const o = parse([]);
  assert.strictEqual(o.top, 10);
  assert.strictEqual(o.runs, 3);
  assert.throws(() => parse(['--top', '0']));
  assert.throws(() => parse(['--min-recall', '2']));
  assert.throws(() => parse(['--bogus']));
});

run('loadTasks rejects a task without an expected list', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-bench-tasks-'));
  const f = path.join(tmp, 't.json');
  fs.writeFileSync(f, JSON.stringify({ tasks: [{ id: 'x', query: 'q', expected: [] }] }));
  assert.throws(() => loadTasks(f));
  fs.rmSync(tmp, { recursive: true, force: true });
});

run('the shipped task file loads and every expected path is a real file in this repo', () => {
  const tasks = loadTasks(path.join(__dirname, '..', 'benchmarks', 'egc', 'tasks.json'));
  assert.ok(tasks.length >= 6);
  for (const t of tasks) {
    for (const rel of t.expected) {
      assert.ok(fs.existsSync(path.join(__dirname, '..', rel)), `${t.id}: ${rel} exists`);
    }
  }
});

run('summarise averages recall and sums tokens over the rows', () => {
  const s = summarise([
    { recallAt5: 1, recallAtTop: 1, reciprocalRank: 1, latencyMsP50: 5, latencyMsP95: 9, briefingTokens: 10, wholeFileTokens: 100 },
    { recallAt5: 0, recallAtTop: 0, reciprocalRank: 0, latencyMsP50: 7, latencyMsP95: 11, briefingTokens: 20, wholeFileTokens: 300 }
  ]);
  assert.strictEqual(s.meanRecallAt5, 0.5);
  assert.strictEqual(s.briefingTokensTotal, 30);
  assert.strictEqual(s.wholeFileTokensTotal, 400);
});

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'file-rank.js');
if (!fs.existsSync(buildPath)) {
  console.log('  SKIP end-to-end run (guardian build not found)');
} else {
  run('end-to-end run prints the table and writes JSON; a high --min-recall fails with exit 1', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-bench-e2e-'));
    const out = path.join(tmp, 'out.json');
    const r = spawnSync(process.execPath, [path.join(bench, 'run.js'), '--runs', '1', '--out', out], { encoding: 'utf8', timeout: 600000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('mean recall@5'));
    const json = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(json.rows.length >= 6);
    assert.ok(json.summary.meanRecallAtTop >= 0 && json.summary.meanRecallAtTop <= 1);
    const impossible = path.join(tmp, 'impossible.json');
    fs.writeFileSync(impossible, JSON.stringify({ tasks: [{ id: 'none', query: 'chargeCard', expected: ['no/such/file.ts'] }] }));
    const strict = spawnSync(process.execPath, [path.join(bench, 'run.js'), '--tasks', impossible, '--runs', '1', '--min-recall', '0.5'], { encoding: 'utf8', timeout: 600000 });
    assert.strictEqual(strict.status, 1, 'recall 0 is below 0.5');
    assert.ok(strict.stderr.includes('below --min-recall'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
