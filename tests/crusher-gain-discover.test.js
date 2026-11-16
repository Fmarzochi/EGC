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
  const home = tempDir('egc-gain-home-');
  const ledgerDir = path.join(home, '.egc', 'metrics');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const entry = { ts: '2026-07-26T04:00:00Z', kind: 'git-log', cmd: 'git log --stat', tokensSaved: 5000, bytesIn: 100000, bytesOut: 2000 };
  fs.writeFileSync(path.join(ledgerDir, 'crusher.jsonl'), `${JSON.stringify(entry)}\n`);

  const res = spawnSync('node', [GAIN, '--history', '--json'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      EGC_CRUSHER_METRICS_FILE: path.join(ledgerDir, 'crusher.jsonl'),
    },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const entries = JSON.parse(res.stdout);
  assert.ok(Array.isArray(entries), 'history is an array');
  assert.strictEqual(entries.length, 1, 'exactly the seeded entry is reported');
  assert.strictEqual(entries[0].cmd, entry.cmd, 'the raw ledger entry is returned verbatim');
  assert.strictEqual(entries[0].tokensSaved, entry.tokensSaved, 'savings carry through');
});

run('gain --history prints local time with its offset and leaves the ledger in UTC (#1659)', () => {
  const home = tempDir('egc-gain-home-');
  const ledgerDir = path.join(home, '.egc', 'metrics');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const ledger = path.join(ledgerDir, 'crusher.jsonl');
  const line = `${JSON.stringify({ ts: '2026-07-26T04:00:00Z', kind: 'git-log', cmd: 'git log --stat', tokensSaved: 5000, bytesIn: 100000, bytesOut: 2000 })}\n`;
  fs.writeFileSync(ledger, line);
  const historyIn = tz => spawnSync('node', [GAIN, '--history'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, EGC_CRUSHER_METRICS_FILE: ledger, TZ: tz },
  });

  const utc = historyIn('UTC');
  assert.strictEqual(utc.status, 0, utc.stderr);
  assert.ok(utc.stdout.includes('2026-07-26 04:00 +00:00  git-log'), `UTC line, got: ${utc.stdout}`);

  const saoPaulo = historyIn('America/Sao_Paulo');
  assert.strictEqual(saoPaulo.status, 0, saoPaulo.stderr);
  assert.ok(saoPaulo.stdout.includes('2026-07-26 01:00 -03:00  git-log'), `Sao Paulo line, got: ${saoPaulo.stdout}`);

  assert.strictEqual(fs.readFileSync(ledger, 'utf8'), line, 'the ledger keeps its UTC timestamp');
});

run('gain summary prints the biggest crush with its command', () => {
  const home = tempDir('egc-gain-home-');
  const ledgerDir = path.join(home, '.egc', 'metrics');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const entry = { ts: '2026-07-26T04:00:00Z', kind: 'git-log', cmd: 'git log --stat', tokensSaved: 5000, bytesIn: 100000, bytesOut: 2000 };
  fs.writeFileSync(path.join(ledgerDir, 'crusher.jsonl'), `${JSON.stringify(entry)}\n`);

  const res = spawnSync('node', [GAIN], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
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

run('gain --share prints totals, kinds and layers and nothing that names the machine, a project or a session (#2139)', () => {
  const home = tempDir('egc-gain-home-');
  const ledgerDir = path.join(home, '.egc', 'metrics');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const project = path.join(home, 'work', 'secret-client-project');
  const rows = [
    { ts: '2026-11-16T01:00:00Z', kind: 'git-log', cmd: 'git log --stat', layer: 'shim', tokensSaved: 3000, bytesIn: 50000, bytesOut: 1000, session: 'ses_private_42', project },
    { ts: '2026-11-16T01:01:00Z', kind: 'npm-install', cmd: 'npm install', layer: 'run', tokensSaved: 1000, bytesIn: 20000, bytesOut: 4000, session: 'ses_private_42', project },
  ];
  fs.writeFileSync(path.join(ledgerDir, 'crusher.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, EGC_CRUSHER_METRICS_FILE: path.join(ledgerDir, 'crusher.jsonl') };

  const text = spawnSync('node', [GAIN, '--share'], { encoding: 'utf8', env });
  assert.strictEqual(text.status, 0, text.stderr);
  assert.ok(text.stdout.includes('| Crushed runs | 2 |'), text.stdout);
  assert.ok(text.stdout.includes('| Tokens saved | ~4.0K |'), text.stdout);
  assert.ok(text.stdout.includes('| Efficiency | 93% |'), text.stdout);
  assert.ok(text.stdout.includes('By command kind: git-log ~3.0K, npm-install ~1.0K'), text.stdout);
  assert.ok(text.stdout.includes('By layer: shim ~3.0K, run ~1.0K'), text.stdout);
  for (const secret of [home, project, 'secret-client-project', 'ses_private_42', 'git log --stat']) {
    assert.ok(!text.stdout.includes(secret), `the shared block must not carry ${secret}`);
  }

  const json = spawnSync('node', [GAIN, '--share', '--json'], { encoding: 'utf8', env });
  assert.strictEqual(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.deepStrictEqual(Object.keys(report).sort(), ['byKind', 'byLayer', 'bytesIn', 'bytesOut', 'efficiency', 'runs', 'tokensSaved']);
  assert.deepStrictEqual(report.byLayer, { shim: { runs: 1, tokensSaved: 3000 }, run: { runs: 1, tokensSaved: 1000 } });
  for (const secret of [home, project, 'ses_private_42', 'git log']) {
    assert.ok(!json.stdout.includes(secret), `the JSON must not carry ${secret}`);
  }

  const empty = spawnSync('node', [GAIN, '--share'], { encoding: 'utf8', env: { ...env, EGC_CRUSHER_METRICS_FILE: path.join(ledgerDir, 'none.jsonl') } });
  assert.strictEqual(empty.status, 0, empty.stderr);
  assert.ok(empty.stdout.includes('nothing to share'), empty.stdout);
});

for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
run('no directory a case made is left behind, including one a case made without tempDir', () => {
  assert.ok(tempDirs.length >= 4, 'the cases made their directories through tempDir');
  assert.deepStrictEqual(prefixedTempDirs().filter(name => !tempDirsBefore.has(name)), []);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
