'use strict';
/**
 * Tests for scripts/hooks/crusher-hook.js: the standalone Token Crusher hook
 * installed on hosts other than Claude Code (Codex, CodeBuddy). It reuses the
 * crusher rewrite decision and returns a genuine rewrite as
 * hookSpecificOutput.updatedInput, so the host applies `egc run` before the
 * command executes. Everything else passes through untouched (fail-open).
 *
 * Run with: node tests/hooks/crusher-hook.test.js
 */
const assert = require('node:assert');
const path = require('node:path');

const { run } = require(path.join(__dirname, '..', '..', 'scripts', 'hooks', 'crusher-hook.js'));

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

const bashInput = command => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
const POSIX = process.platform !== 'win32';

console.log('\n=== Testing crusher-hook (standalone) ===\n');

process.env.EGC_ASSUME_EGC_CLI = '1';

runCase('a crushable command is returned as hookSpecificOutput.updatedInput', () => {
  const out = JSON.parse(run(bashInput('git log --oneline -50')));
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(out.hookSpecificOutput.updatedInput.command, 'egc run git log --oneline -50');
});

runCase('a generic command passes through untouched', () => {
  const raw = bashInput('ls -la src');
  assert.strictEqual(run(raw), raw);
});

runCase('an already-wrapped egc run command passes through', () => {
  const raw = bashInput('egc run git log');
  assert.strictEqual(run(raw), raw);
});

runCase('malformed input fails open (returned verbatim)', () => {
  assert.strictEqual(run('not json'), 'not json');
});

runCase('without the egc CLI nothing is rewritten', () => {
  process.env.EGC_ASSUME_EGC_CLI = '0';
  const raw = bashInput('git log --oneline -50');
  assert.strictEqual(run(raw), raw);
  process.env.EGC_ASSUME_EGC_CLI = '1';
});

if (POSIX) {
  runCase('a recognized pipeline is wrapped via egc run --shell', () => {
    const out = JSON.parse(run(bashInput("git log | head -5")));
    assert.strictEqual(out.hookSpecificOutput.updatedInput.command, "egc run --shell 'git log | head -5'");
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
