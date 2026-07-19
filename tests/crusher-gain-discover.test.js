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

console.log('\n=== Testing egc gain --history and egc discover ===\n');

run('gain --history --json returns the raw ledger entries', () => {
  const res = spawnSync('node', [GAIN, '--history', '--json'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  const entries = JSON.parse(res.stdout);
  assert.ok(Array.isArray(entries), 'history is an array');
});

run('discover finds a crushable run in a fixture transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-discover-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-discover-empty-'));
  const res = spawnSync('node', [DISCOVER, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, EGC_DISCOVER_DIR: dir },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.strictEqual(report.missedRuns, 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
