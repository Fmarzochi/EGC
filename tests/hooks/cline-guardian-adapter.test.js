/**
 * Tests for scripts/hooks/cline-guardian-adapter.js
 *
 * Cline's PreToolUse input shape is {preToolUse: {toolName, parameters}},
 * not Claude Code's {tool_name, tool_input}, so the remapping IS tested
 * here (unlike Junie). Cline's output schema (validateHookOutput in the
 * real cline/cline source, confirmed 2026-07-29) only recognizes cancel/
 * contextModification/errorMessage -- there is no exit-code contract like
 * Junie's (Cline honors the JSON body regardless of exit code), so every
 * case here asserts exit 0 and checks `cancel` in the body instead.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'cline-guardian-adapter.js');
const fakeCli = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');

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
  const result = spawnSync('node', [adapterScript], {
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

// The Cline SDK and CLI read the same .clinerules/hooks/PreToolUse, but their
// shell tool is run_commands (cline/cline sdk/packages/core/src/runtime/
// orchestration/runtime-builder.ts maps execute_command and bash to it), and
// its input takes several shapes (RunCommandsInputUnionSchema in
// extensions/tools/schemas.ts). The hook payload carries the raw input in
// tool_call.input and a string-valued copy in preToolUse.parameters
// (sdk/packages/core/src/hooks/hook-file-hooks.ts).
function sdkCall(input) {
  return {
    hookName: 'tool_call',
    tool_call: { id: 'call-1', name: 'run_commands', input },
    preToolUse: {
      toolName: 'run_commands',
      parameters: Object.fromEntries(Object.entries(input && typeof input === 'object' && !Array.isArray(input) ? input : {})
        .map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])),
    },
  };
}

function responseOf(payload) {
  const result = runAdapterCli(payload);
  assert.strictEqual(result.code, 0, 'Cline honors the JSON body regardless of exit code');
  return JSON.parse(result.stdout);
}

function runRunCommandsCases() {
  return [
    test('CLI: run_commands blocks when any of its commands is destructive', () => {
      const response = responseOf(sdkCall({ commands: ['git status', 'rm -rf /'] }));
      assert.strictEqual(response.cancel, true);
      assert.ok(response.errorMessage && response.errorMessage.length > 0);
    }),

    test('CLI: run_commands allows when every command is safe', () => {
      assert.deepStrictEqual(responseOf(sdkCall({ commands: ['git status', 'git log -1'] })), { cancel: false });
    }),

    test('CLI: run_commands judges every input shape the SDK accepts', () => {
      for (const input of [
        'rm -rf /',
        ['git status', 'rm -rf /'],
        { command: 'rm -rf /' },
        { cmd: 'rm -rf /' },
        { commands: 'rm -rf /' },
        [{ command: 'rm', args: ['-rf', '/'] }],
        { commands: [{ command: 'rm', args: ['-rf', '/'] }] },
        { command: 'rm', args: ['-rf', '/'] },
      ]) {
        assert.strictEqual(responseOf(sdkCall(input)).cancel, true, `blocked: ${JSON.stringify(input)}`);
      }
    }),

    test('CLI: run_commands is judged from preToolUse.parameters when tool_call is absent', () => {
      const payload = sdkCall({ commands: ['rm -rf /'] });
      delete payload.tool_call;
      assert.strictEqual(responseOf(payload).cancel, true);
    }),

    test('CLI: a run_commands input the Guardian cannot read is refused, not waved through', () => {
      const response = responseOf(sdkCall({ commands: [42] }));
      assert.strictEqual(response.cancel, true);
      assert.ok(/could not be read/i.test(response.errorMessage), response.errorMessage);
    }),

    test('CLI: an empty run_commands runs nothing and allows', () => {
      assert.deepStrictEqual(responseOf(sdkCall({ commands: [] })), { cancel: false });
    }),

    test('CLI: run_commands judges every key it carries, so no command hides behind another', () => {
      for (const input of [
        { commands: 'echo ok', command: 'rm -rf /' },
        { cmd: 'echo ok', commands: ['rm -rf /'] },
        { commands: [], cmd: 'rm -rf /' },
      ]) {
        assert.strictEqual(responseOf(sdkCall(input)).cancel, true, `blocked: ${JSON.stringify(input)}`);
      }
    }),

    test('CLI: a structured command is judged both as its argv and as plain words, so an interpreter script is seen', () => {
      assert.strictEqual(responseOf(sdkCall({ commands: [{ command: 'bash', args: ['-c', 'rm -rf /'] }] })).cancel, true);
      assert.deepStrictEqual(responseOf(sdkCall({ commands: [{ command: 'git', args: ['status'] }] })), { cancel: false });
    }),

    test('CLI: an execute_command that only carries tool_call is still judged', () => {
      const response = responseOf({ tool_call: { id: 'call-1', name: 'execute_command', input: { command: 'rm -rf /' } } });
      assert.strictEqual(response.cancel, true);
    }),
  ];
}

function runTests() {
  console.log('\n=== Testing cline-guardian-adapter ===\n');

  let passed = 0;
  let failed = 0;

  if (test('CLI: allows a safe execute_command (exit 0, {cancel: false})', () => {
    const result = runAdapterCli({ preToolUse: { toolName: 'execute_command', parameters: { command: 'git status' } } });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { cancel: false });
  })) passed++; else failed++;

  if (test('CLI: blocks a destructive execute_command ({cancel: true, errorMessage})', () => {
    const result = runAdapterCli({ preToolUse: { toolName: 'execute_command', parameters: { command: 'rm -rf /' } } });
    assert.strictEqual(result.code, 0, 'Cline honors the JSON body regardless of exit code');
    const response = JSON.parse(result.stdout);
    assert.strictEqual(response.cancel, true);
    assert.ok(response.errorMessage && response.errorMessage.length > 0, 'expected a non-empty errorMessage');
  })) passed++; else failed++;

  if (test('CLI: a non-execute_command tool (e.g. read_file) allows untouched', () => {
    const result = runAdapterCli({ preToolUse: { toolName: 'read_file', parameters: { command: 'rm -rf /', path: '/etc/passwd' } } });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { cancel: false });
  })) passed++; else failed++;

  if (test('CLI: execute_command with no command parameter allows (exit 0)', () => {
    const result = runAdapterCli({ preToolUse: { toolName: 'execute_command', parameters: {} } });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { cancel: false });
  })) passed++; else failed++;

  if (test('CLI: malformed stdin JSON fails open ({cancel: false})', () => {
    const result = runAdapterCli('not json');
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { cancel: false });
  })) passed++; else failed++;

  if (test('CLI: a truncated oversized payload fails CLOSED ({cancel: true}) -- Guardian is a security boundary', () => {
    const oversizedPadding = 'x'.repeat(2 * 1024 * 1024);
    const oversizedInput = JSON.stringify({
      preToolUse: { toolName: 'execute_command', parameters: { command: 'git status' } },
      padding: oversizedPadding,
    });
    const result = runAdapterCli(oversizedInput);
    assert.strictEqual(result.code, 0);
    const response = JSON.parse(result.stdout);
    assert.strictEqual(response.cancel, true, 'Expected fail-closed on truncated oversized input');
  })) passed++; else failed++;

  if (test('CLI: full stdout is present at exit (no truncation from exitCode-based exit)', () => {
    for (let i = 0; i < 20; i += 1) {
      const result = runAdapterCli({ preToolUse: { toolName: 'execute_command', parameters: { command: 'git status' } } });
      assert.doesNotThrow(() => JSON.parse(result.stdout), `Run ${i}: stdout was not valid JSON: ${JSON.stringify(result.stdout)}`);
    }
  })) passed++; else failed++;

  const runCommandsResults = runRunCommandsCases();
  passed += runCommandsResults.filter(Boolean).length;
  failed += runCommandsResults.filter(ok => !ok).length;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
