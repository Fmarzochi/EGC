/**
 * Tests for scripts/hooks/antigravity-guardian-adapter.js
 *
 * Antigravity's PreToolUse contract (antigravity.google/docs/hooks): a
 * {toolCall: {name, args}, workspacePaths} event on stdin and a
 * {decision, reason} object on stdout. Checked here: the translation of
 * each guarded tool into the shape the Guardian validators read, and the
 * real entrypoint end to end against the deterministic guardian stand-in.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'antigravity-guardian-adapter.js');
const fakeCli = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');
const { buildGuardianInput } = require(adapterScript);

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

function event(name, args, extra = {}) {
  return { toolCall: { name, args }, workspacePaths: ['/workspace/app'], conversationId: 'c-1', ...extra };
}

function runAdapter(input) {
  const result = spawnSync(process.execPath, [adapterScript], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, EGC_GUARDIAN_CLI: fakeCli },
    timeout: 15000,
  });
  return { code: result.status, output: JSON.parse(result.stdout || 'null') };
}

function runTests() {
  console.log('\n=== Testing antigravity-guardian-adapter ===\n');
  const results = [];

  results.push(test('run_command becomes a Guardian Bash input with the command and its Cwd', () => {
    assert.deepStrictEqual(
      buildGuardianInput(event('run_command', { CommandLine: 'npm test', Cwd: '/workspace/app/pkg' })),
      { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: '/workspace/app/pkg' }
    );
  }));

  results.push(test('run_command without Cwd runs in the first workspace', () => {
    assert.strictEqual(buildGuardianInput(event('run_command', { CommandLine: 'ls' })).cwd, '/workspace/app');
  }));

  results.push(test('write_to_file carries the target and the content it writes', () => {
    assert.deepStrictEqual(
      buildGuardianInput(event('write_to_file', { TargetFile: 'run.sh', CodeContent: 'echo hi\n' })).tool_input,
      { file_path: 'run.sh', content: 'echo hi\n' }
    );
  }));

  results.push(test('replace_file_content becomes one edit of the target', () => {
    assert.deepStrictEqual(
      buildGuardianInput(event('replace_file_content', { TargetFile: 'a.sh', TargetContent: 'old', ReplacementContent: 'new', AllowMultiple: true })).tool_input,
      { file_path: 'a.sh', old_string: 'old', new_string: 'new', replace_all: true }
    );
  }));

  results.push(test('multi_replace_file_content becomes the list of its chunks', () => {
    const input = buildGuardianInput(event('multi_replace_file_content', {
      TargetFile: 'a.sh',
      ReplacementChunks: [{ TargetContent: 'x', ReplacementContent: 'y' }, { ReplacementContent: 'z' }, null],
    }));
    assert.deepStrictEqual(input.tool_input, {
      file_path: 'a.sh',
      edits: [
        { old_string: 'x', new_string: 'y', replace_all: false },
        { old_string: '', new_string: 'z', replace_all: false },
      ],
    });
    assert.strictEqual(input.cwd, '/workspace/app');
  }));

  results.push(test('tools the Guardian does not judge, and malformed calls, map to nothing', () => {
    assert.strictEqual(buildGuardianInput(event('view_file', { AbsolutePath: '/etc/hostname' })), null);
    assert.strictEqual(buildGuardianInput(event('run_command', { Cwd: '/workspace/app' })), null);
    assert.strictEqual(buildGuardianInput(event('write_to_file', { CodeContent: 'x' })), null);
    assert.strictEqual(buildGuardianInput({ toolCall: 'run_command' }), null);
    assert.strictEqual(buildGuardianInput(null), null);
  }));

  results.push(test('a destructive command is denied with the Guardian reason', () => {
    const { code, output } = runAdapter(event('run_command', { CommandLine: 'rm -rf ./victim', Cwd: '/workspace/app' }));
    assert.strictEqual(code, 0);
    assert.strictEqual(output.decision, 'deny');
    assert.match(output.reason, /destructive/);
  }));

  results.push(test('a write to a protected path is denied', () => {
    const { output } = runAdapter(event('write_to_file', { TargetFile: '/home/person/.ssh/authorized_keys', CodeContent: 'key' }));
    assert.strictEqual(output.decision, 'deny');
  }));

  // The write validator reads a lone edit at the top of tool_input (Claude
  // Code's Edit shape) as well as an edits array, so every write tool here
  // has the content it would leave in a shell script judged.
  results.push(test('a shell script that would run a denied command is denied, through each write tool', () => {
    const script = '/workspace/app/run.sh';
    for (const input of [
      event('write_to_file', { TargetFile: script, CodeContent: '#!/bin/sh\nrm -rf /\n' }),
      event('replace_file_content', { TargetFile: script, TargetContent: 'echo safe', ReplacementContent: 'rm -rf /' }),
      event('multi_replace_file_content', { TargetFile: script, ReplacementChunks: [{ TargetContent: 'a', ReplacementContent: 'rm -rf /' }] }),
    ]) {
      const { output } = runAdapter(input);
      assert.strictEqual(output.decision, 'deny', `${input.toolCall.name} must be judged on its content`);
      assert.match(output.reason, /script runs a denied command/);
    }
    assert.deepStrictEqual(
      runAdapter(event('replace_file_content', { TargetFile: script, TargetContent: 'a', ReplacementContent: 'echo ok' })).output,
      { decision: 'ask' }
    );
  }));

  results.push(test('an allowed command, an allowed write and an unguarded tool are left to the user permission settings', () => {
    for (const input of [
      event('run_command', { CommandLine: 'git status', Cwd: '/workspace/app' }),
      event('write_to_file', { TargetFile: '/workspace/app/notes.txt', CodeContent: 'x' }),
      event('view_file', { AbsolutePath: '/workspace/app/notes.txt' }),
    ]) {
      assert.deepStrictEqual(runAdapter(input).output, { decision: 'ask' });
    }
  }));

  results.push(test('unreadable input is left to the user, never answered with an empty decision that Antigravity treats as a denial', () => {
    assert.deepStrictEqual(runAdapter('not json').output, { decision: 'ask' });
  }));

  results.push(test('a payload cut at the size cap is denied', () => {
    const command = `echo ${'a'.repeat(1024 * 1024)}`;
    assert.strictEqual(runAdapter(event('run_command', { CommandLine: command })).output.decision, 'deny');
  }));

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  return failed === 0;
}

process.exit(runTests() ? 0 : 1);
