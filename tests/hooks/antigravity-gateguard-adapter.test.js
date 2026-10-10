/**
 * Tests for scripts/hooks/antigravity-gateguard-adapter.js
 *
 * Antigravity's PreToolUse contract (antigravity.google/docs/hooks): a
 * {toolCall: {name, args}, conversationId, workspacePaths} event on stdin
 * and a {decision, reason} object on stdout. Checked here: the translation
 * of each guarded tool into the shape gateguard-fact-force.js reads, keyed
 * by the conversation and without the transcript, and the real entrypoint
 * end to end: the first call of a conversation is refused with the facts to
 * present, the identical retry passes.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'antigravity-gateguard-adapter.js');
const { buildGateGuardInput, extractDenyReason } = require(adapterScript);

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
  return { toolCall: { name, args }, workspacePaths: ['/workspace/app'], conversationId: 'conv-1', ...extra };
}

// One state directory per scenario: the gate remembers what it refused.
function withStateDir(fn) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-gateguard-test-'));
  try {
    fn(stateDir);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function runAdapter(stateDir, input) {
  const result = spawnSync(process.execPath, [adapterScript], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, GATEGUARD_STATE_DIR: stateDir, EGC_DISABLED_HOOKS: '' },
    timeout: 15000,
  });
  return { code: result.status, output: JSON.parse(result.stdout || 'null'), stderr: result.stderr || '' };
}

function runTests() {
  console.log('\n=== Testing antigravity-gateguard-adapter ===\n');
  const results = [];

  results.push(test('run_command becomes a Bash input keyed by the conversation, without the transcript Antigravity names', () => {
    assert.deepStrictEqual(
      buildGateGuardInput(event('run_command', { CommandLine: 'npm test', Cwd: '/workspace/app' }, { transcriptPath: '/home/person/.gemini/t.jsonl' })),
      { session_id: 'conv-1', tool_name: 'Bash', tool_input: { command: 'npm test' } }
    );
  }));

  results.push(test('a write tool becomes an Edit of a file that exists and a Write of one that does not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-gateguard-files-'));
    try {
      const existing = path.join(dir, 'present.js');
      fs.writeFileSync(existing, 'x');
      const missing = path.join(dir, 'new.js');
      assert.deepStrictEqual(
        buildGateGuardInput(event('write_to_file', { TargetFile: existing, CodeContent: 'y' })),
        { session_id: 'conv-1', tool_name: 'Edit', tool_input: { file_path: existing } }
      );
      assert.deepStrictEqual(
        buildGateGuardInput(event('replace_file_content', { TargetFile: missing, ReplacementContent: 'y' })),
        { session_id: 'conv-1', tool_name: 'Write', tool_input: { file_path: missing } }
      );
      assert.strictEqual(buildGateGuardInput(event('multi_replace_file_content', { TargetFile: existing, ReplacementChunks: [] })).tool_name, 'Edit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  results.push(test('a relative target is resolved against the Antigravity workspace, not the hook process directory', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-gateguard-workspace-'));
    try {
      fs.writeFileSync(path.join(workspace, 'present.js'), 'x');
      const existing = buildGateGuardInput(event('write_to_file', { TargetFile: 'present.js', CodeContent: 'y' }, { workspacePaths: [workspace] }));
      assert.deepStrictEqual(existing, { session_id: 'conv-1', tool_name: 'Edit', tool_input: { file_path: path.join(workspace, 'present.js') } });
      const created = buildGateGuardInput(event('write_to_file', { TargetFile: path.join('src', 'new.js'), CodeContent: 'y' }, { workspacePaths: [workspace] }));
      assert.deepStrictEqual(created, { session_id: 'conv-1', tool_name: 'Write', tool_input: { file_path: path.join(workspace, 'src', 'new.js') } });
      assert.strictEqual(buildGateGuardInput(event('write_to_file', { TargetFile: 'loose.js' }, { workspacePaths: [] })).tool_input.file_path, 'loose.js', 'with no workspace the target is passed as given');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }));

  results.push(test('tools the gate does not judge, calls without their argument, and events with no tool call map to nothing', () => {
    assert.strictEqual(buildGateGuardInput(event('view_file', { AbsolutePath: '/etc/hostname' })), null);
    assert.strictEqual(buildGateGuardInput(event('run_command', { Cwd: '/workspace/app' })), null);
    assert.strictEqual(buildGateGuardInput(event('write_to_file', { CodeContent: 'x' })), null);
    assert.strictEqual(buildGateGuardInput({ toolCall: 'run_command' }), null);
    assert.strictEqual(buildGateGuardInput(null), null);
  }));

  results.push(test('extractDenyReason reads the gate denial and nothing else', () => {
    const denial = { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'present the facts' } }) };
    assert.strictEqual(extractDenyReason(denial), 'present the facts');
    assert.strictEqual(extractDenyReason({ stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } }) }), 'Blocked by the GateGuard Fact-Forcing Gate.');
    assert.strictEqual(extractDenyReason({ stdout: 'not json' }), null);
    assert.strictEqual(extractDenyReason({ stderr: 'warning only', exitCode: 0 }), null);
    assert.strictEqual(extractDenyReason('raw input passed through'), null);
  }));

  results.push(test('the first shell command of a conversation is refused with the facts to present; the identical retry passes', () => {
    withStateDir(stateDir => {
      const first = runAdapter(stateDir, event('run_command', { CommandLine: 'ls', Cwd: '/workspace/app' }));
      assert.strictEqual(first.code, 0);
      assert.strictEqual(first.output.decision, 'deny');
      assert.match(first.output.reason, /\[Fact-Forcing Gate\][\s\S]*present these facts:/, 'the reason carries the facts the gate asks for');
      const retry = runAdapter(stateDir, event('run_command', { CommandLine: 'ls', Cwd: '/workspace/app' }));
      assert.deepStrictEqual(retry.output, { decision: 'ask' });
    });
  }));

  results.push(test('a file write is refused first and passes on the identical retry', () => {
    withStateDir(stateDir => {
      const target = path.join(stateDir, 'notes.md');
      const first = runAdapter(stateDir, event('write_to_file', { TargetFile: target, CodeContent: '# notes' }));
      assert.strictEqual(first.output.decision, 'deny');
      assert.match(first.output.reason, /\[Fact-Forcing Gate\][\s\S]*present these facts:/, 'the reason carries the facts the gate asks for');
      assert.ok(first.output.reason.includes(target), 'the facts name the file');
      assert.deepStrictEqual(runAdapter(stateDir, event('write_to_file', { TargetFile: target, CodeContent: '# notes' })).output, { decision: 'ask' });
    });
  }));

  results.push(test('each conversation has its own gate', () => {
    withStateDir(stateDir => {
      runAdapter(stateDir, event('run_command', { CommandLine: 'ls' }));
      runAdapter(stateDir, event('run_command', { CommandLine: 'ls' }));
      const other = runAdapter(stateDir, event('run_command', { CommandLine: 'ls' }, { conversationId: 'conv-2' }));
      assert.strictEqual(other.output.decision, 'deny', 'a new conversation is asked for its facts again');
    });
  }));

  results.push(test('an unguarded tool and unreadable input are left to the user, never answered with an empty decision', () => {
    withStateDir(stateDir => {
      assert.deepStrictEqual(runAdapter(stateDir, event('view_file', { AbsolutePath: '/workspace/app/notes.txt' })).output, { decision: 'ask' });
      assert.deepStrictEqual(runAdapter(stateDir, 'not json').output, { decision: 'ask' });
    });
  }));

  results.push(test('a payload cut at the size cap is denied', () => {
    withStateDir(stateDir => {
      const command = `echo ${'a'.repeat(1024 * 1024)}`;
      const { output } = runAdapter(stateDir, event('run_command', { CommandLine: command }));
      assert.strictEqual(output.decision, 'deny');
      assert.match(output.reason, /exceeded the size/);
    });
  }));

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  return failed === 0;
}

process.exit(runTests() ? 0 : 1);
