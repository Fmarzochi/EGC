'use strict';
/**
 * Tests for scripts/lib/crusher/engine.js and scripts/lib/crusher/metrics.js
 *
 * Covers the Token Crusher conservativeness contract: small outputs pass
 * through, errors and failures survive crushing, already-crushed output is
 * never crushed twice, and the savings ledger aggregates correctly.
 *
 * Run with: node tests/crusher-engine.test.js
 */
const assert = require('node:assert');
const path = require('node:path');

const { CRUSH_MARKER, commandKind, crushOutput, estimateTokens } = require(
  path.join(__dirname, '..', 'scripts', 'lib', 'crusher', 'engine.js')
);
const { aggregate } = require(
  path.join(__dirname, '..', 'scripts', 'lib', 'crusher', 'metrics.js')
);

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
const run = (name, fn) => { if (test(name, fn)) passed++; else failed++; };

console.log('\n=== Testing Token Crusher engine ===\n');

run('classifies commands into kinds', () => {
  assert.strictEqual(commandKind('git log --oneline'), 'git-log');
  assert.strictEqual(commandKind('git diff HEAD~1'), 'git-diff');
  assert.strictEqual(commandKind('npx jest --ci'), 'test-runner');
  assert.strictEqual(commandKind('npm test'), 'test-runner');
  assert.strictEqual(commandKind('yarn install'), 'pm-install');
  assert.strictEqual(commandKind('gh pr list --json number'), 'gh-json');
  assert.strictEqual(commandKind('ls -la'), 'generic');
  assert.strictEqual(commandKind('rtk git log'), 'git-log');
});

run('small outputs pass through untouched', () => {
  assert.strictEqual(crushOutput('git log', 'short output'), null);
});

run('generic commands never crush', () => {
  assert.strictEqual(crushOutput('cat somefile', 'x'.repeat(10000)), null);
});

run('git log beyond the cap is truncated with a count', () => {
  const output = Array.from({ length: 200 }, (_, i) => `commit${i} message ${'x'.repeat(30)}`).join('\n');
  const result = crushOutput('git log --oneline', output);
  assert.ok(result);
  assert.ok(result.crushed.includes('more commits'));
  assert.ok(result.crushed.includes(CRUSH_MARKER));
  assert.ok(result.tokensSaved > 0);
});

run('test-runner output keeps failures and summary, drops noise', () => {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(`  ok test case number ${i} does something fine`);
  lines.push('  FAIL src/thing.test.js broke badly');
  lines.push('  Error: expected 1 to be 2');
  lines.push('Tests: 1 failed, 300 passed, 301 total');
  const result = crushOutput('npx jest', lines.join('\n'));
  assert.ok(result);
  assert.ok(result.crushed.includes('broke badly'), 'failure line survives');
  assert.ok(result.crushed.includes('Error: expected'), 'error detail survives');
  assert.ok(result.crushed.includes('Tests: 1 failed'), 'summary survives');
  assert.ok(!result.crushed.includes('number 42 does something fine'), 'noise dropped');
});

run('pm install keeps warnings and the tail summary', () => {
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(`added package-${i}`);
  lines.splice(200, 0, 'npm WARN deprecated something@1.0.0');
  lines.push('added 400 packages in 12s');
  const result = crushOutput('npm install', lines.join('\n'));
  assert.ok(result);
  assert.ok(result.crushed.includes('WARN deprecated'));
  assert.ok(result.crushed.includes('added 400 packages in 12s'));
});

run('already-crushed output is never crushed twice', () => {
  const output = `${'x\n'.repeat(3000)}${CRUSH_MARKER} saved ~100 tokens`;
  assert.strictEqual(crushOutput('git log', output), null);
});

run('oversized git diff collapses to a summary', () => {
  const hunk = 'diff --git a/f.js b/f.js\n+++ b/f.js\n@@ -1,3 +1,3 @@\n' + '+added line\n-removed line\n'.repeat(1000);
  const result = crushOutput('git diff', hunk);
  assert.ok(result);
  assert.ok(result.crushed.includes('diff too large'));
  assert.ok(result.crushed.includes('+1000/-1000'));
});

run('token estimate is bytes over four, rounded up', () => {
  assert.strictEqual(estimateTokens('abcd'), 1);
  assert.strictEqual(estimateTokens('abcde'), 2);
});

run('ledger aggregation sums totals and per-kind buckets', () => {
  const totals = aggregate([
    { kind: 'git-log', bytesIn: 1000, bytesOut: 100, tokensSaved: 225 },
    { kind: 'git-log', bytesIn: 500, bytesOut: 50, tokensSaved: 100 },
    { kind: 'test-runner', bytesIn: 2000, bytesOut: 200, tokensSaved: 450 },
  ]);
  assert.strictEqual(totals.runs, 3);
  assert.strictEqual(totals.tokensSaved, 775);
  assert.strictEqual(totals.byKind['git-log'].runs, 2);
  assert.strictEqual(totals.byKind['test-runner'].tokensSaved, 450);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
