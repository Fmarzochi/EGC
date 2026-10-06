'use strict';

/**
 * Tests for scripts/hooks/crush-guardian-adapter.js
 *
 * Exercises Crush Guardian hook adapter:
 * - Event translation from Crush PreToolUse payload to Guardian Bash/Write inputs.
 * - Both bash and edit/write/multiedit tool routing.
 * - Truncation handling (fail-closed exit 2).
 * - CLI subprocess execution with allow/block contracts.
 */

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'crush-guardian-adapter.js');
const fakeCli = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');
const { buildGuardianEvent, runCrushGuardianAdapter } = require(adapterScript);

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

function runTests() {
  console.log('\n=== Testing crush-guardian-adapter ===\n');

  let passed = 0;
  let failed = 0;

  if (test('buildGuardianEvent maps bash tool events accurately', () => {
    const event = {
      tool_name: 'bash',
      tool_input: { command: 'echo hello' },
      cwd: '/workspace/project',
    };
    const mapped = buildGuardianEvent(event);
    assert.deepStrictEqual(mapped, {
      kind: 'bash',
      input: {
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
        cwd: '/workspace/project',
      },
    });
  })) passed++; else failed++;

  if (test('buildGuardianEvent accepts alternate aliases tool and working_dir', () => {
    const event = {
      tool: 'BASH',
      input: { command: 'ls' },
      working_dir: '/tmp',
    };
    const mapped = buildGuardianEvent(event);
    assert.deepStrictEqual(mapped, {
      kind: 'bash',
      input: {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        cwd: '/tmp',
      },
    });
  })) passed++; else failed++;

  if (test('buildGuardianEvent derives command from top-level if missing from input', () => {
    const event = {
      tool_name: 'bash',
      command: 'git status',
    };
    const mapped = buildGuardianEvent(event);
    assert.strictEqual(mapped.kind, 'bash');
    assert.strictEqual(mapped.input.tool_input.command, 'git status');
  })) passed++; else failed++;

  if (test('buildGuardianEvent maps write, edit, and multiedit tools to Write inputs', () => {
    const writeEvent = {
      tool_name: 'write',
      tool_input: { path: 'src/index.js', content: 'console.log(1);' },
    };
    const mappedWrite = buildGuardianEvent(writeEvent);
    assert.deepStrictEqual(mappedWrite, {
      kind: 'write',
      input: {
        tool_name: 'Write',
        tool_input: { path: 'src/index.js', file_path: 'src/index.js', content: 'console.log(1);' },
      },
    });

    const editEvent = {
      tool_name: 'edit',
      tool_input: { file_path: 'src/app.js' },
    };
    const mappedEdit = buildGuardianEvent(editEvent);
    assert.strictEqual(mappedEdit.kind, 'write');
    assert.strictEqual(mappedEdit.input.tool_name, 'Edit');
    assert.strictEqual(mappedEdit.input.tool_input.path, 'src/app.js');

    const multiEditEvent = {
      tool_name: 'multiedit',
      tool_input: { file: 'src/main.rs' },
    };
    const mappedMulti = buildGuardianEvent(multiEditEvent);
    assert.strictEqual(mappedMulti.kind, 'write');
    assert.strictEqual(mappedMulti.input.tool_name, 'MultiEdit');
    assert.strictEqual(mappedMulti.input.tool_input.path, 'src/main.rs');
  })) passed++; else failed++;

  if (test('buildGuardianEvent returns null for unhandled tools or non-object payloads', () => {
    assert.strictEqual(buildGuardianEvent(null), null);
    assert.strictEqual(buildGuardianEvent('not an object'), null);
    assert.strictEqual(buildGuardianEvent({ tool_name: 'unknown_tool' }), null);
    assert.strictEqual(buildGuardianEvent({}), null);
  })) passed++; else failed++;

  if (test('runCrushGuardianAdapter fails closed on truncation', () => {
    const result = runCrushGuardianAdapter({ tool_name: 'bash', tool_input: { command: 'ls' } }, { truncated: true });
    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.stderr.includes('BLOCKED'));
  })) passed++; else failed++;

  if (test('runCrushGuardianAdapter allows non-matching or invalid JSON payload', () => {
    const res1 = runCrushGuardianAdapter('invalid json');
    assert.strictEqual(res1.exitCode, 0);

    const res2 = runCrushGuardianAdapter({ tool_name: 'read_file' });
    assert.strictEqual(res2.exitCode, 0);
  })) passed++; else failed++;

  if (test('CLI: allows safe bash command with exit 0', () => {
    const result = runAdapterCli({
      tool_name: 'bash',
      tool_input: { command: 'git status' },
      cwd: '/tmp',
    });
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  if (test('CLI: blocks destructive bash command with exit 2', () => {
    const result = runAdapterCli({
      tool_name: 'bash',
      tool_input: { command: 'rm -rf /' },
      cwd: '/tmp',
    });
    assert.strictEqual(result.code, 2);
    assert.ok(result.stderr.length > 0);
  })) passed++; else failed++;

  if (test('CLI: allows safe write operation with exit 0', () => {
    const result = runAdapterCli({
      tool_name: 'write',
      tool_input: { path: 'test.txt' },
      cwd: '/tmp',
    });
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  if (test('CLI: blocks write to protected file with exit 2', () => {
    const result = runAdapterCli({
      tool_name: 'write',
      tool_input: { path: '/home/user/.ssh/id_rsa' },
      cwd: '/tmp',
    });
    assert.strictEqual(result.code, 2);
    assert.ok(result.stderr.length > 0);
  })) passed++; else failed++;

  if (test('CLI: allows invalid or null json without error', () => {
    const nullRes = runAdapterCli('null');
    assert.strictEqual(nullRes.code, 0);

    const badJsonRes = runAdapterCli('{broken');
    assert.strictEqual(badJsonRes.code, 0);
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
