'use strict';

/**
 * Tests for scripts/hooks/vibe-guardian-adapter.js
 *
 * Mistral Vibe runs a pre_tool hook with the tool call as JSON on stdin and
 * reads a {decision, reason} object from stdout: silence allows, "deny"
 * denies, and a non-zero exit is a hook failure rather than a denial. These
 * tests cover the event translation, both routings (shell tools and edit),
 * the fail-closed answer to a truncated payload, and the CLI contract.
 */

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const fakeCli = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');
process.env.EGC_GUARDIAN_CLI = fakeCli;

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'vibe-guardian-adapter.js');
const { buildGuardianInput, runVibeGuardianAdapter } = require(adapterScript);

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

console.log('\n=== Testing vibe-guardian-adapter ===\n');

tally(test('buildGuardianInput maps every Vibe shell tool to the Bash Guardian, with the command and cwd', () => {
  for (const tool of ['bash', 'git_bash', 'experimental_bash', 'experimental_git_bash']) {
    const mapped = buildGuardianInput({ tool_name: tool, tool_input: { command: 'echo hello', timeout: 5 }, cwd: '/work' });
    assert.strictEqual(mapped.kind, 'bash', tool);
    assert.strictEqual(mapped.input.tool_name, 'Bash');
    assert.strictEqual(mapped.input.tool_input.command, 'echo hello');
    assert.strictEqual(mapped.input.cwd, '/work');
  }
}));

tally(test('buildGuardianInput maps edit to the write Guardian on file_path, and leaves the other tools alone', () => {
  const mapped = buildGuardianInput({ tool_name: 'edit', tool_input: { file_path: '/work/a.js', old_string: 'x', new_string: 'y' } });
  assert.strictEqual(mapped.kind, 'write');
  assert.strictEqual(mapped.input.tool_name, 'Edit');
  assert.strictEqual(mapped.input.tool_input.file_path, '/work/a.js');
  assert.strictEqual(mapped.input.tool_input.path, '/work/a.js');
  assert.strictEqual(buildGuardianInput({ tool_name: 'grep', tool_input: { pattern: 'x' } }), null);
  assert.strictEqual(buildGuardianInput({ tool_name: 'read_file', tool_input: { file_path: '/a' } }), null);
  assert.strictEqual(buildGuardianInput({ tool_name: 'bash', tool_input: {} }), null, 'a shell call without a command is not judged');
  assert.strictEqual(buildGuardianInput('not an object'), null);
  assert.strictEqual(buildGuardianInput({ tool_input: { command: 'ls' } }), null, 'no tool name, no judgement');
}));

tally(test('runVibeGuardianAdapter allows a harmless command and denies a destructive one with the reason', () => {
  assert.deepStrictEqual(runVibeGuardianAdapter({ tool_name: 'bash', tool_input: { command: 'echo hello' } }), { blocked: false });
  const denied = runVibeGuardianAdapter({ tool_name: 'bash', tool_input: { command: 'rm -rf /' } });
  assert.strictEqual(denied.blocked, true);
  assert.match(denied.reason, /destructive/);
}));

tally(test('runVibeGuardianAdapter denies an edit of a protected path and fails closed on a truncated payload', () => {
  const denied = runVibeGuardianAdapter({ tool_name: 'edit', tool_input: { file_path: '/home/person/.ssh/id_rsa', old_string: '', new_string: 'x' } });
  assert.strictEqual(denied.blocked, true);
  const truncated = runVibeGuardianAdapter({ tool_name: 'bash', tool_input: { command: 'echo hello' } }, { truncated: true });
  assert.strictEqual(truncated.blocked, true);
  assert.match(truncated.reason, /exceeded the size/);
  assert.deepStrictEqual(runVibeGuardianAdapter('{not json'), { blocked: false }, 'unreadable input is not a tool call to judge');
}));

tally(test('CLI: a harmless command exits 0 with nothing on stdout', () => {
  const result = runAdapterCli({ tool_name: 'bash', tool_input: { command: 'echo hello' }, cwd: '/work' });
  assert.strictEqual(result.code, 0, result.stderr);
  assert.strictEqual(result.stdout, '');
}));

tally(test('CLI: a destructive command exits 0 with a deny decision and the reason on stdout', () => {
  const result = runAdapterCli({ tool_name: 'git_bash', tool_input: { command: 'rm -rf /' } });
  assert.strictEqual(result.code, 0, 'a denial is an answer, never a hook failure');
  const answer = JSON.parse(result.stdout);
  assert.strictEqual(answer.decision, 'deny');
  assert.match(answer.reason, /destructive/);
}));

tally(test('CLI: a payload over the size cap is denied, and text that is not JSON passes through silently', () => {
  const huge = JSON.stringify({ tool_name: 'bash', tool_input: { command: `echo ${'x'.repeat(2 * 1024 * 1024)}` } });
  const result = runAdapterCli(huge);
  assert.strictEqual(result.code, 0);
  assert.strictEqual(JSON.parse(result.stdout).decision, 'deny');
  const plain = runAdapterCli('not json at all');
  assert.strictEqual(plain.code, 0);
  assert.strictEqual(plain.stdout, '');
}));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
