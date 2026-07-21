'use strict';
/**
 * Tests for scripts/hooks/pre-bash-crusher-rewrite.js
 *
 * Covers the fail-open contract of the Token Crusher rewrite: simple crushable
 * commands route through `egc run`; recognized pipelines and compound commands
 * route through `egc run --shell '<escaped>'` with a bash-verified round trip
 * proving the escaping is exact; backgrounding, redirection, generic, wrapped
 * and malformed input all pass through untouched.
 *
 * Run with: node tests/hooks/pre-bash-crusher-rewrite.test.js
 */
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { run } = require(path.join(__dirname, '..', '..', 'scripts', 'hooks', 'pre-bash-crusher-rewrite.js'));

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
const runCase = (name, fn) => { if (test(name, fn)) passed++; else failed++; };

function invoke(command) {
  const out = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));
  return JSON.parse(out).tool_input.command;
}

// Lets bash itself re-parse the single argument the rewrite produced, so the
// test proves the escaping is exact rather than trusting the regex. printf only
// echoes the argument; it never executes the wrapped command.
function bashSees(rewritten) {
  const arg = rewritten.replace(/^egc run --shell /, '');
  return execFileSync('/bin/bash', ['-c', `printf '%s' ${arg}`], { encoding: 'utf8' });
}

console.log('\n=== Testing pre-bash-crusher-rewrite ===\n');

process.env.EGC_ASSUME_EGC_CLI = '1';

runCase('simple crushable command routes through egc run', () => {
  assert.strictEqual(invoke('git log --oneline -200'), 'egc run git log --oneline -200');
});

runCase('generic command passes through', () => {
  assert.strictEqual(invoke('ls -la src'), 'ls -la src');
});

runCase('recognized pipeline routes through --shell', () => {
  assert.strictEqual(invoke('git log | head -5'), "egc run --shell 'git log | head -5'");
});

runCase('recognized chaining routes through --shell', () => {
  assert.strictEqual(invoke('git log && git status'), "egc run --shell 'git log && git status'");
});

runCase('gh json piped to jq is wrapped and bash re-parses it exactly', () => {
  const original = "gh pr list --json number | jq '.[].number'";
  const rewritten = invoke(original);
  assert.ok(rewritten.startsWith("egc run --shell '"), rewritten);
  assert.strictEqual(bashSees(rewritten), original);
});

runCase('gh --jq flag without a pipe stays a simple egc run', () => {
  assert.strictEqual(
    invoke("gh pr list --json number --jq '.[].number'"),
    "egc run gh pr list --json number --jq '.[].number'",
  );
});

runCase('escaping survives embedded single quotes, pipes and double quotes', () => {
  const original = 'gh pr view 950 --json x --jq \'.x[] | select(.name=="a")\'';
  const rewritten = invoke(original);
  assert.strictEqual(bashSees(rewritten), original);
});

runCase('command substitution is re-parsed by bash, not altered', () => {
  const original = 'git log --format=%H | grep $(git rev-parse HEAD)';
  const rewritten = invoke(original);
  assert.strictEqual(bashSees(rewritten), original);
});

runCase('backgrounding passes through untouched', () => {
  assert.strictEqual(invoke('npm test &'), 'npm test &');
  assert.strictEqual(invoke('git log | tail &'), 'git log | tail &');
});

runCase('redirection passes through untouched', () => {
  assert.strictEqual(invoke('git diff > out.txt'), 'git diff > out.txt');
  assert.strictEqual(invoke('git log 2> err.txt'), 'git log 2> err.txt');
});

runCase('&& is not mistaken for backgrounding', () => {
  assert.ok(invoke('npm test && echo ok').startsWith('egc run --shell'));
});

runCase('already wrapped or raw commands pass through', () => {
  assert.strictEqual(invoke('egc run git log'), 'egc run git log');
  assert.strictEqual(invoke('git log --raw'), 'git log --raw');
});

runCase('malformed input passes through unchanged', () => {
  assert.strictEqual(run('not json'), 'not json');
});

runCase('without the egc CLI nothing is rewritten', () => {
  process.env.EGC_ASSUME_EGC_CLI = '0';
  assert.strictEqual(invoke('git log | head'), 'git log | head');
  process.env.EGC_ASSUME_EGC_CLI = '1';
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
