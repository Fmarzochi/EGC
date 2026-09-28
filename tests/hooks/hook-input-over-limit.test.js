/**
 * A hook that gates a command or a write reads at most 1 MiB of its input;
 * one cut at that size cannot be validated, so it is refused instead of let
 * through. The observational post hooks still pass it on.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const hooks = path.join(__dirname, '..', '..', 'scripts', 'hooks');
const OVER = 1024 * 1024 + 4096;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

const wipe = ['rm', '-rf', '/'].join(' ');
const bashInput = size => JSON.stringify({ tool_name: 'Bash', tool_input: { command: `${wipe} # ${'x'.repeat(size)}` } });
const writeInput = size => JSON.stringify({
  tool_name: 'Write',
  tool_input: { file_path: path.join(require('os').homedir(), '.ssh', 'authorized_keys'), content: 'x'.repeat(size) },
});
const run = (script, args, input) => spawnSync(process.execPath, [path.join(hooks, script), ...args], {
  input,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, EGC_HOOK_PROFILE: 'standard', EGC_DISABLED_HOOKS: '' },
});

function runTests() {
  console.log('\n=== Testing hook input over the size the hooks read ===\n');
  let passed = 0;
  let failed = 0;
  const record = ok => (ok ? passed++ : failed++);

  record(test('the Bash hook refuses a command cut at the size it reads', () => {
    const result = run('pre-bash-guardian-validate.js', [], bashInput(OVER));
    assert.strictEqual(result.status, 2, result.stderr);
    assert.match(result.stderr, /larger than the 1 MiB/);
  }));

  record(test('the write hook refuses a write cut at the size it reads', () => {
    const result = run('pre-write-guardian-validate.js', [], writeInput(OVER));
    assert.strictEqual(result.status, 2, result.stderr);
    assert.match(result.stderr, /larger than the 1 MiB/);
  }));

  record(test('the Bash dispatcher denies a command cut at the size it reads, and its post side lets it by', () => {
    const pre = run('bash-hook-dispatcher.js', ['pre'], bashInput(OVER));
    assert.strictEqual(pre.status, 0, pre.stderr);
    assert.match(pre.stdout, /"permissionDecision":"deny"/);
    assert.match(pre.stdout, /larger than the 1 MiB/);
    const post = run('bash-hook-dispatcher.js', ['post'], bashInput(OVER));
    assert.strictEqual(post.status, 0, post.stderr);
    assert.doesNotMatch(post.stdout, /"permissionDecision":"deny"/);
  }));

  record(test('the pre-bash dispatcher denies a command cut at the size it reads', () => {
    const pre = run('pre-bash-dispatcher.js', [], bashInput(OVER));
    assert.strictEqual(pre.status, 0, pre.stderr);
    assert.match(pre.stdout, /"permissionDecision":"deny"/);
    assert.match(pre.stdout, /larger than the 1 MiB/);
  }));

  record(test('run-with-flags hands the cut to each guardian hook, which refuses it', () => {
    for (const [id, script, input] of [
      ['pre:config-protection', 'scripts/hooks/pre-write-guardian-validate.js', writeInput(OVER)],
      ['pre:bash:guardian-validate', 'scripts/hooks/pre-bash-guardian-validate.js', bashInput(OVER)],
    ]) {
      const result = run('run-with-flags.js', [id, script, 'minimal,standard,strict'], input);
      assert.strictEqual(result.status, 2, `${script}: ${result.stderr}`);
      assert.match(result.stderr, /larger than the 1 MiB/, script);
    }
  }));

  record(test('run() refuses a cut input it is handed, and judges an uncut one', () => {
    const bash = require(path.join(hooks, 'pre-bash-guardian-validate.js'));
    const write = require(path.join(hooks, 'pre-write-guardian-validate.js'));
    assert.strictEqual(bash.run('{"tool_input":{"command":"ls"}}', { truncated: true }).exitCode, 2);
    assert.strictEqual(write.run('{"tool_input":{"file_path":"a.txt"}}', { truncated: true }).exitCode, 2);
    assert.strictEqual(bash.run('{"tool_input":{"command":"ls"}}', { truncated: false }).exitCode, 0);
    assert.strictEqual(bash.run('{"tool_input":{"command":"ls"}}').exitCode, 0);
  }));

  record(test('an input of exactly the size is read whole, not refused', () => {
    const exact = (make, base) => make(1024 * 1024 - make(0).length + base);
    const bash = exact(size => JSON.stringify({ tool_name: 'Bash', tool_input: { command: `ls # ${'x'.repeat(size)}` } }), 0);
    const write = exact(size => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'notes.txt', content: 'x'.repeat(size) } }), 0);
    assert.strictEqual(Buffer.byteLength(bash), 1024 * 1024);
    assert.strictEqual(Buffer.byteLength(write), 1024 * 1024);
    assert.doesNotMatch(run('pre-bash-guardian-validate.js', [], bash).stderr, /larger than/);
    assert.doesNotMatch(run('pre-write-guardian-validate.js', [], write).stderr, /larger than/);
    assert.doesNotMatch(run('bash-hook-dispatcher.js', ['pre'], bash).stdout, /larger than/);
    assert.doesNotMatch(run('pre-bash-dispatcher.js', [], bash).stdout, /larger than/);
  }));

  record(test('an input under the size is read whole, as before', () => {
    const bash = run('pre-bash-guardian-validate.js', [], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
    assert.strictEqual(bash.status, 0, bash.stderr);
    assert.doesNotMatch(bash.stderr, /larger than/);
    for (const [script, args] of [['bash-hook-dispatcher.js', ['pre']], ['pre-bash-dispatcher.js', []]]) {
      const pre = run(script, args, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
      assert.doesNotMatch(pre.stdout, /larger than/, script);
    }
    const write = run('pre-write-guardian-validate.js', [], JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'notes.txt', content: 'x' } }));
    assert.strictEqual(write.status, 0, write.stderr);
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
