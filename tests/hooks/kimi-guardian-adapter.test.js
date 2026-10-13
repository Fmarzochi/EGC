'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const fakeCli = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');
process.env.EGC_GUARDIAN_CLI = fakeCli;

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'kimi-guardian-adapter.js');
const { buildGuardianInput, runKimiGuardianAdapter } = require(adapterScript);

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
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

console.log('\n=== Testing kimi-guardian-adapter ===\n');

tally(test('buildGuardianInput maps Bash and the legacy Shell to the Bash Guardian, with the command and cwd', () => {
  for (const tool of ['Bash', 'Shell']) {
    const mapped = buildGuardianInput({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: 'echo hello' }, cwd: '/work' });
    assert.strictEqual(mapped.kind, 'bash', tool);
    assert.strictEqual(mapped.input.tool_name, 'Bash');
    assert.strictEqual(mapped.input.tool_input.command, 'echo hello');
    assert.strictEqual(mapped.input.cwd, '/work');
  }
}));

tally(test('buildGuardianInput maps Write, Edit and the legacy file tools to the write Guardian through the path argument', () => {
  for (const tool of ['Write', 'Edit', 'WriteFile', 'StrReplaceFile']) {
    const mapped = buildGuardianInput({ tool_name: tool, tool_input: { path: '/work/a.js' } });
    assert.strictEqual(mapped.kind, 'write', tool);
    assert.strictEqual(mapped.input.tool_input.file_path, '/work/a.js');
    assert.strictEqual(mapped.input.tool_input.path, '/work/a.js');
  }
  const fallback = buildGuardianInput({ tool_name: 'Edit', tool_input: { file_path: '/work/b.js' } });
  assert.strictEqual(fallback.input.tool_input.path, '/work/b.js', 'a file_path argument is accepted too');
}));

tally(test('buildGuardianInput leaves the other tools and malformed events alone', () => {
  assert.strictEqual(buildGuardianInput({ tool_name: 'Read', tool_input: { path: '/a' } }), null);
  assert.strictEqual(buildGuardianInput({ tool_name: 'Bash', tool_input: {} }), null, 'a shell call without a command is not judged');
  assert.strictEqual(buildGuardianInput({ tool_name: 'Write', tool_input: {} }), null, 'a write without a path is not judged');
  assert.strictEqual(buildGuardianInput('not an object'), null);
  assert.strictEqual(buildGuardianInput({ tool_input: { command: 'ls' } }), null, 'no tool name, no judgement');
}));

tally(test('runKimiGuardianAdapter allows a harmless command, denies a destructive one and a protected edit, and fails closed on a truncated payload', () => {
  assert.deepStrictEqual(runKimiGuardianAdapter({ tool_name: 'Bash', tool_input: { command: 'echo hello' } }), { blocked: false });
  const denied = runKimiGuardianAdapter({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  assert.strictEqual(denied.blocked, true);
  assert.match(denied.reason, /destructive/);
  assert.strictEqual(runKimiGuardianAdapter({ tool_name: 'Edit', tool_input: { path: '/home/person/.ssh/id_rsa' } }).blocked, true);
  const truncated = runKimiGuardianAdapter({ tool_name: 'Bash', tool_input: { command: 'echo hello' } }, { truncated: true });
  assert.strictEqual(truncated.blocked, true);
  assert.match(truncated.reason, /exceeded the size/);
  assert.deepStrictEqual(runKimiGuardianAdapter('{not json'), { blocked: false });
}));

tally(test('CLI: a harmless command exits 0 with nothing on either stream', () => {
  const result = runAdapterCli({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hello' }, cwd: '/work' });
  assert.strictEqual(result.code, 0, result.stderr);
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(result.stderr, '');
}));

tally(test('CLI: a destructive command exits 2 with the reason on stderr, which Kimi shows as the block reason', () => {
  const result = runAdapterCli({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  assert.strictEqual(result.code, 2, 'Kimi blocks on exit code 2');
  assert.match(result.stderr, /destructive/);
}));

tally(test('CLI: a protected write is blocked, a payload over the size cap is blocked, and text that is not JSON passes through silently', () => {
  const write = runAdapterCli({ tool_name: 'Write', tool_input: { path: '/home/person/.ssh/id_rsa', content: 'x' } });
  assert.strictEqual(write.code, 2);
  const huge = runAdapterCli(JSON.stringify({ tool_name: 'Bash', tool_input: { command: `echo ${'x'.repeat(2 * 1024 * 1024)}` } }));
  assert.strictEqual(huge.code, 2);
  assert.match(huge.stderr, /exceeded the size/);
  const plain = runAdapterCli('not json at all');
  assert.strictEqual(plain.code, 0);
  assert.strictEqual(plain.stderr, '');
}));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
