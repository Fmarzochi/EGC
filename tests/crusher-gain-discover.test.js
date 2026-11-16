'use strict';
/**
 * Tests for the egc gain (--history) and egc discover reports.
 * Both read local files only; discover is pointed at a fixture transcript
 * via EGC_DISCOVER_DIR so the test never touches real session data.
 *
 * Run with: node tests/crusher-gain-discover.test.js
 */
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { seedLedger } = require('./fixtures/crusher-ledger');
const ROOT = path.join(__dirname, '..');
const GAIN = path.join(ROOT, 'scripts', 'gain.js');
const DISCOVER = path.join(ROOT, 'scripts', 'discover.js');

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

// Every directory a case makes, removed once the cases have run, and the
// ones with the same prefixes that were there before, which are not ours.
const TEMP_PREFIXES = ['egc-gain-home-', 'egc-discover-'];
const prefixedTempDirs = () => fs.readdirSync(os.tmpdir()).filter(name => TEMP_PREFIXES.some(prefix => name.startsWith(prefix)));
const tempDirsBefore = new Set(prefixedTempDirs());
const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

console.log('\n=== Testing egc gain --history and egc discover ===\n');

run('gain --history --json returns the raw ledger entries', () => {
  // Point the spawned child at a synthetic HOME so --json reports exactly the
  // seeded ledger instead of the real ~/.egc ledger, whose size would exceed
  // the spawn buffer and kill the child with status === null.
  const entry = { ts: '2026-07-26T04:00:00Z', kind: 'git-log', cmd: 'git log --stat', tokensSaved: 5000, bytesIn: 100000, bytesOut: 2000 };
  const { env } = seedLedger(tempDir('egc-gain-home-'), [entry]);

  const res = spawnSync('node', [GAIN, '--history', '--json'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, env });
  assert.strictEqual(res.status, 0, res.stderr);
  const entries = JSON.parse(res.stdout);
  assert.ok(Array.isArray(entries), 'history is an array');
  assert.strictEqual(entries.length, 1, 'exactly the seeded entry is reported');
  assert.strictEqual(entries[0].cmd, entry.cmd, 'the raw ledger entry is returned verbatim');
  assert.strictEqual(entries[0].tokensSaved, entry.tokensSaved, 'savings carry through');
});

run('gain reports the savings by layer: the shim, the egc run prefix, and the rows written before layers (#2136)', () => {
  const home = tempDir('egc-gain-home-');
  const ledgerDir = path.join(home, '.egc', 'metrics');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const rows = [
    { ts: '2026-11-16T01:00:00Z', kind: 'git-log', cmd: 'git', layer: 'shim', tokensSaved: 3000, bytesIn: 50000, bytesOut: 1000 },
    { ts: '2026-11-16T01:01:00Z', kind: 'git-diff', cmd: 'git', layer: 'shim', tokensSaved: 2000, bytesIn: 30000, bytesOut: 800 },
    { ts: '2026-11-16T01:02:00Z', kind: 'test-runner', cmd: 'npm', layer: 'run', tokensSaved: 4000, bytesIn: 60000, bytesOut: 900 },
    { ts: '2026-11-16T01:03:00Z', kind: 'gh-json', cmd: 'gh', tokensSaved: 500, bytesIn: 9000, bytesOut: 700 },
  ];
  fs.writeFileSync(path.join(ledgerDir, 'crusher.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, EGC_CRUSHER_METRICS_FILE: path.join(ledgerDir, 'crusher.jsonl') };

  const text = spawnSync('node', [GAIN], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, env });
  assert.strictEqual(text.status, 0, text.stderr);
  assert.match(text.stdout, /By layer/, 'the report has a layer section');
  assert.match(text.stdout, /shim\s+2 runs\s+~\s*5\.0K/, `the shim layer sums its two rows: ${text.stdout}`);
  assert.match(text.stdout, /run\s+1 runs\s+~\s*4\.0K/, 'the egc run layer has its row');
  assert.match(text.stdout, /unlabeled\s+1 runs/, 'a row written before layers is reported as unlabeled, not dropped');

  const json = spawnSync('node', [GAIN, '--json'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, env });
  assert.strictEqual(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.deepStrictEqual(report.byLayer, {
    shim: { runs: 2, tokensSaved: 5000 },
    run: { runs: 1, tokensSaved: 4000 },
    unlabeled: { runs: 1, tokensSaved: 500 },
  });
});

run('gain --history prints local time with its offset and leaves the ledger in UTC (#1659)', () => {
  const row = { ts: '2026-07-26T04:00:00Z', kind: 'git-log', cmd: 'git log --stat', tokensSaved: 5000, bytesIn: 100000, bytesOut: 2000 };
  const line = `${JSON.stringify(row)}\n`;
  const { env, ledgerPath: ledger } = seedLedger(tempDir('egc-gain-home-'), [row]);
  const historyIn = tz => spawnSync('node', [GAIN, '--history'], { encoding: 'utf8', env: { ...env, TZ: tz } });

  const utc = historyIn('UTC');
  assert.strictEqual(utc.status, 0, utc.stderr);
  assert.ok(utc.stdout.includes('2026-07-26 04:00 +00:00  git-log'), `UTC line, got: ${utc.stdout}`);

  const saoPaulo = historyIn('America/Sao_Paulo');
  assert.strictEqual(saoPaulo.status, 0, saoPaulo.stderr);
  assert.ok(saoPaulo.stdout.includes('2026-07-26 01:00 -03:00  git-log'), `Sao Paulo line, got: ${saoPaulo.stdout}`);

  assert.strictEqual(fs.readFileSync(ledger, 'utf8'), line, 'the ledger keeps its UTC timestamp');
});

run('gain summary prints the biggest crush with its command', () => {
  const entry = { ts: '2026-07-26T04:00:00Z', kind: 'git-log', cmd: 'git log --stat', tokensSaved: 5000, bytesIn: 100000, bytesOut: 2000 };
  const { env } = seedLedger(tempDir('egc-gain-home-'), [entry]);

  const res = spawnSync('node', [GAIN], { encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, res.stderr);
  // Regression for the .command/.cmd mismatch: the ledger stores `cmd`, so the
  // Biggest crush line must surface the command instead of never printing.
  assert.match(res.stdout, /Biggest crush:.*git log --stat/);
});

run('discover finds a crushable run in a fixture transcript', () => {
  const dir = tempDir('egc-discover-');
  const bigLog = 'commit abc123 something\n'.repeat(200);
  const lines = [
    JSON.stringify({
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'git log' } }],
      },
    }),
    JSON.stringify({
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: bigLog }] }],
      },
    }),
    JSON.stringify({
      message: {
        content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'egc run git log' } }],
      },
    }),
    JSON.stringify({
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: bigLog }] }],
      },
    }),
    JSON.stringify({
      message: {
        content: [{ type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'ls -la' } }],
      },
    }),
    JSON.stringify({
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: [{ type: 'text', text: bigLog }] }],
      },
    }),
  ];
  fs.writeFileSync(path.join(dir, 'session.jsonl'), lines.join('\n'));

  const res = spawnSync('node', [DISCOVER, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, EGC_DISCOVER_DIR: dir },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.strictEqual(report.missedRuns, 1, 'only the bare git log counts');
  assert.ok(report.byKind['git-log'], 'classified as git-log');
  assert.ok(report.potentialTokens > 0, 'estimates recoverable tokens');
});

run('discover reports zero on an empty directory', () => {
  const dir = tempDir('egc-discover-empty-');
  const res = spawnSync('node', [DISCOVER, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, EGC_DISCOVER_DIR: dir },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.strictEqual(report.missedRuns, 0);
});

for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
run('no directory a case made is left behind, including one a case made without tempDir', () => {
  assert.ok(tempDirs.length >= 4, 'the cases made their directories through tempDir');
  assert.deepStrictEqual(prefixedTempDirs().filter(name => !tempDirsBefore.has(name)), []);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
