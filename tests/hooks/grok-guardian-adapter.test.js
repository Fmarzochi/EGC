'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const fakeCli = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');
process.env.EGC_GUARDIAN_CLI = fakeCli;

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'grok-guardian-adapter.js');
const { buildGuardianInput, runGrokGuardianAdapter } = require(adapterScript);

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

function runAdapterCli(input, env = {}) {
  const result = spawnSync(process.execPath, [adapterScript], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, EGC_GUARDIAN_CLI: fakeCli, ...env },
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

let passed = 0;
let failed = 0;
const tally = ok => { if (ok) passed++; else failed++; };

console.log('\n=== Testing grok-guardian-adapter ===\n');

tally(test('buildGuardianInput maps the Grok Bash tool to the Bash Guardian, with the command and cwd (#1495)', () => {
  const mapped = buildGuardianInput({ hookEventName: 'PreToolUse', toolName: 'Bash', toolInput: { command: 'echo hello' }, cwd: '/work' });
  assert.strictEqual(mapped.kind, 'bash');
  assert.strictEqual(mapped.input.tool_name, 'Bash');
  assert.strictEqual(mapped.input.tool_input.command, 'echo hello');
  assert.strictEqual(mapped.input.cwd, '/work');
  const snake = buildGuardianInput({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.strictEqual(snake.kind, 'bash', 'the Claude Code field names Grok also recognizes work too');
}));

tally(test('buildGuardianInput maps Edit and Write to the write Guardian, and leaves the other tools alone (#1495)', () => {
  for (const tool of ['Edit', 'Write']) {
    const mapped = buildGuardianInput({ toolName: tool, toolInput: { file_path: '/work/a.js' } });
    assert.strictEqual(mapped.kind, 'write', tool);
    assert.strictEqual(mapped.input.tool_input.file_path, '/work/a.js');
    assert.strictEqual(mapped.input.tool_input.path, '/work/a.js');
  }
  assert.strictEqual(buildGuardianInput({ toolName: 'Read', toolInput: { file_path: '/a' } }), null);
  assert.strictEqual(buildGuardianInput({ toolName: 'Bash', toolInput: {} }), null, 'a shell call without a command is not judged');
  assert.strictEqual(buildGuardianInput('not an object'), null);
  assert.strictEqual(buildGuardianInput({ toolInput: { command: 'ls' } }), null, 'no tool name, no judgement');
}));

tally(test('runGrokGuardianAdapter allows a harmless command, denies a destructive one and a protected edit, and fails closed on a truncated payload (#1495)', () => {
  assert.deepStrictEqual(runGrokGuardianAdapter({ toolName: 'Bash', toolInput: { command: 'echo hello' } }), { blocked: false });
  const denied = runGrokGuardianAdapter({ toolName: 'Bash', toolInput: { command: 'rm -rf /' } });
  assert.strictEqual(denied.blocked, true);
  assert.match(denied.reason, /destructive/);
  assert.strictEqual(runGrokGuardianAdapter({ toolName: 'Edit', toolInput: { file_path: '/home/person/.ssh/id_rsa' } }).blocked, true);
  const truncated = runGrokGuardianAdapter({ toolName: 'Bash', toolInput: { command: 'echo hello' } }, { truncated: true });
  assert.strictEqual(truncated.blocked, true);
  assert.match(truncated.reason, /exceeded the size/);
  assert.deepStrictEqual(runGrokGuardianAdapter('{not json'), { blocked: false });
}));

tally(test('CLI: a harmless command exits 0 with nothing on stdout (#1495)', () => {
  const result = runAdapterCli({ hookEventName: 'PreToolUse', toolName: 'Bash', toolInput: { command: 'echo hello' }, cwd: '/work' });
  assert.strictEqual(result.code, 0, result.stderr);
  assert.strictEqual(result.stdout, '');
}));

tally(test('CLI: a destructive command exits 2 with a deny decision on stdout and the reason on stderr (#1495)', () => {
  const result = runAdapterCli({ hookEventName: 'PreToolUse', toolName: 'Bash', toolInput: { command: 'rm -rf /' } });
  assert.strictEqual(result.code, 2, 'Grok denies on exit code 2');
  const answer = JSON.parse(result.stdout);
  assert.strictEqual(answer.decision, 'deny');
  assert.match(answer.reason, /destructive/);
  assert.match(result.stderr, /destructive/);
}));

tally(test('CLI: a payload over the size cap is denied, and text that is not JSON passes through silently (#1495)', () => {
  const huge = JSON.stringify({ toolName: 'Bash', toolInput: { command: `echo ${'x'.repeat(2 * 1024 * 1024)}` } });
  const result = runAdapterCli(huge);
  assert.strictEqual(result.code, 2);
  assert.strictEqual(JSON.parse(result.stdout).decision, 'deny');
  const plain = runAdapterCli('not json at all');
  assert.strictEqual(plain.code, 0);
  assert.strictEqual(plain.stdout, '');
}));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
