/**
 * A hook that gates a command or a write reads at most 1 MiB of its input;
 * one cut at that size cannot be validated, so it is refused instead of let
 * through. The observational post hooks still pass it on.
 */
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
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
// A command of multibyte characters: fewer UTF-16 units than bytes, so a
// reader that counted units would take it for smaller than it is.
const multibyteInput = bytes => JSON.stringify({ tool_name: 'Bash', tool_input: { command: `${wipe} # ${'é'.repeat(Math.ceil(bytes / 2))}` } });
const DENY = /"permissionDecision":\s*"deny"/;
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

  record(test('an input of exactly the size is read whole and judged, not refused', () => {
    const exact = (make, base) => make(1024 * 1024 - Buffer.byteLength(make(0)) + base);
    const bash = exact(size => JSON.stringify({ tool_name: 'Bash', tool_input: { command: `ls # ${'x'.repeat(size)}` } }), 0);
    const write = exact(size => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'notes.txt', content: 'x'.repeat(size) } }), 0);
    // Multibyte up to the last few bytes, then single bytes to land on the size.
    const wide = 'é'.repeat(400 * 1024);
    const multibyte = exact(size => JSON.stringify({ tool_name: 'Bash', tool_input: { command: `ls # ${wide}${'x'.repeat(size)}` } }), 0);
    for (const input of [bash, write, multibyte]) assert.strictEqual(Buffer.byteLength(input), 1024 * 1024);
    for (const input of [bash, multibyte]) {
      const hook = run('pre-bash-guardian-validate.js', [], input);
      assert.strictEqual(hook.status, 0, hook.stderr);
      assert.doesNotMatch(hook.stderr, /larger than/);
      for (const [script, args] of [['bash-hook-dispatcher.js', ['pre']], ['pre-bash-dispatcher.js', []]]) {
        const dispatched = run(script, args, input);
        assert.strictEqual(dispatched.status, 0, `${script}: ${dispatched.stderr}`);
        assert.doesNotMatch(dispatched.stdout, DENY, script);
      }
    }
    const written = run('pre-write-guardian-validate.js', [], write);
    assert.strictEqual(written.status, 0, written.stderr);
    assert.doesNotMatch(written.stderr, /larger than/);
  }));

  record(test('an input past the size in multibyte characters is refused, though it holds fewer characters than bytes', () => {
    const input = multibyteInput(OVER);
    assert.ok(input.length < 1024 * 1024 && Buffer.byteLength(input) > 1024 * 1024, 'fewer UTF-16 units than the size, more bytes');
    const hook = run('pre-bash-guardian-validate.js', [], input);
    assert.strictEqual(hook.status, 2, hook.stderr);
    assert.match(hook.stderr, /larger than the 1 MiB/);
    for (const [script, args] of [['bash-hook-dispatcher.js', ['pre']], ['pre-bash-dispatcher.js', []]]) {
      const dispatched = run(script, args, input);
      assert.match(dispatched.stdout, DENY, script);
      assert.match(dispatched.stdout, /larger than the 1 MiB/, script);
    }
    const flagged = run('run-with-flags.js', ['pre:bash:guardian-validate', 'scripts/hooks/pre-bash-guardian-validate.js', 'minimal,standard,strict'], input);
    assert.strictEqual(flagged.status, 2, flagged.stderr);
    const write = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'notes.txt', content: 'é'.repeat(Math.ceil(OVER / 2)) } });
    const written = run('pre-write-guardian-validate.js', [], write);
    assert.strictEqual(written.status, 2, written.stderr);
    assert.match(written.stderr, /larger than the 1 MiB/);
  }));

  record(test('the shared reader counts bytes, keeps an input of exactly the size, and counts a stream that fails as cut', () => {
    const { readHookInput, MAX_HOOK_INPUT_BYTES } = require('../../scripts/lib/guardian-bin');
    const read = feed => {
      const stream = new EventEmitter();
      const results = [];
      readHookInput(value => results.push(value), stream);
      feed(stream);
      assert.strictEqual(results.length, 1, 'the input is handed on once');
      return results[0];
    };
    const exact = read(stream => {
      stream.emit('data', Buffer.alloc(MAX_HOOK_INPUT_BYTES - 2, 0x61));
      stream.emit('data', Buffer.from('é'));
      stream.emit('end');
    });
    assert.strictEqual(exact.truncated, false);
    assert.ok(exact.raw.endsWith('aé'));
    const over = read(stream => {
      stream.emit('data', Buffer.alloc(MAX_HOOK_INPUT_BYTES - 1, 0x61));
      stream.emit('data', 'é');
      stream.emit('end');
    });
    assert.strictEqual(over.truncated, true);
    assert.strictEqual(Buffer.byteLength(over.raw.replace(/\uFFFD$/, '')), MAX_HOOK_INPUT_BYTES - 1);
    const failed = read(stream => {
      stream.emit('data', Buffer.from('{"tool_input":{"command":"ls"'));
      stream.emit('error', new Error('pipe closed'));
      stream.emit('end');
    });
    assert.deepStrictEqual(failed, { raw: '{"tool_input":{"command":"ls"', truncated: true });
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
