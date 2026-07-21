'use strict';
/**
 * Tests for the PreToolUse output envelope in scripts/hooks/bash-hook-dispatcher.js.
 *
 * The pre-bash hook chain rewrites a command inside a bare `{tool_name,
 * tool_input}` object, but hosts (Claude Code, Codex, CodeBuddy) only apply a
 * rewrite delivered as `hookSpecificOutput.updatedInput`. toPreToolUseOutput
 * wraps a genuine rewrite in that envelope and forwards everything else
 * untouched. An integration case spawns the dispatcher end to end to prove a
 * real `git log` comes back as an updatedInput rewrite to `egc run`.
 *
 * Run with: node tests/hooks/bash-dispatcher-rewrite-output.test.js
 */
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DISPATCHER = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'bash-hook-dispatcher.js');
const { toPreToolUseOutput } = require(DISPATCHER);

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

console.log('\n=== Testing bash-hook-dispatcher PreToolUse output ===\n');

runCase('a rewritten command is wrapped as hookSpecificOutput.updatedInput', () => {
  const original = bashInput('git log --oneline -50');
  const final = bashInput('egc run git log --oneline -50');
  const out = JSON.parse(toPreToolUseOutput(original, final));
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(out.hookSpecificOutput.updatedInput.command, 'egc run git log --oneline -50');
});

runCase('updatedInput preserves other tool_input fields', () => {
  const original = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git log', description: 'x' } });
  const final = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'egc run git log', description: 'x' } });
  const out = JSON.parse(toPreToolUseOutput(original, final));
  assert.strictEqual(out.hookSpecificOutput.updatedInput.description, 'x');
});

runCase('an unchanged command passes through untouched', () => {
  const raw = bashInput('ls -la');
  assert.strictEqual(toPreToolUseOutput(raw, raw), raw);
});

runCase('a deny output is forwarded verbatim, not re-wrapped', () => {
  const original = bashInput('rm -rf /');
  const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } });
  assert.strictEqual(toPreToolUseOutput(original, deny), deny);
});

runCase('a legacy decision:block output is forwarded verbatim', () => {
  const original = bashInput('git push');
  const block = JSON.stringify({ decision: 'block', reason: 'nope' });
  assert.strictEqual(toPreToolUseOutput(original, block), block);
});

runCase('malformed final JSON fails open (returned verbatim)', () => {
  assert.strictEqual(toPreToolUseOutput(bashInput('git log'), 'not json'), 'not json');
});

runCase('malformed original JSON fails open', () => {
  const final = bashInput('egc run git log');
  assert.strictEqual(toPreToolUseOutput('not json', final), final);
});

runCase('non-bash input without a command is passed through', () => {
  const original = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/a' } });
  const final = original;
  assert.strictEqual(toPreToolUseOutput(original, final), final);
});

// Integration: spawn the dispatcher end to end with the gates disabled so the
// crusher runs, and confirm a real git log comes back as an updatedInput rewrite.
runCase('dispatcher end-to-end wraps a crushed command as updatedInput', () => {
  const r = spawnSync('node', [DISPATCHER, 'pre'], {
    input: bashInput('git log --oneline -50'),
    encoding: 'utf8',
    env: {
      ...process.env,
      EGC_ASSUME_EGC_CLI: '1',
      EGC_HOOK_PROFILE: 'standard',
      EGC_DISABLED_HOOKS: 'pre:bash:gateguard-fact-force,pre:bash:guardian-validate,pre:bash:verification-gate,pre:bash:block-no-verify,pre:bash:commit-quality',
    },
  });
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.updatedInput.command, 'egc run git log --oneline -50');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
