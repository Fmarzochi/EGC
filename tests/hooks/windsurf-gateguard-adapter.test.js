/**
 * Tests for scripts/hooks/windsurf-gateguard-adapter.js
 *
 * Windsurf Cascade Hooks use a different wire contract than Claude Code/
 * Codex/Continue: stdin is {agent_action_name, tool_info}, not {tool_name,
 * tool_input}, and blocking is signaled with exit code 2 + a stderr reason,
 * not a hookSpecificOutput JSON object on stdout. This file exercises both
 * the pure translation functions and the real CLI entrypoint end to end.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'windsurf-gateguard-adapter.js');
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

function runAdapterCli(input, env = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windsurf-gateguard-test-'));
  try {
    const result = spawnSync('node', [adapterScript], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, GATEGUARD_STATE_DIR: stateDir, ...env },
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      code: Number.isInteger(result.status) ? result.status : 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function runTests() {
  console.log('\n=== Testing windsurf-gateguard-adapter ===\n');

  let passed = 0;
  let failed = 0;

  if (test('maps pre_write_code on a new file to a gateguard Write input', () => {
    const mapped = buildGateGuardInput({
      agent_action_name: 'pre_write_code',
      trajectory_id: 'traj-1',
      tool_info: { file_path: path.join(os.tmpdir(), `windsurf-does-not-exist-${Date.now()}.js`) },
    });
    assert.strictEqual(mapped.tool_name, 'Write');
    assert.strictEqual(mapped.session_id, 'traj-1');
  })) passed++; else failed++;

  if (test('maps pre_write_code on an existing file to a gateguard Edit input', () => {
    const existingFile = path.join(os.tmpdir(), `windsurf-exists-${Date.now()}.js`);
    fs.writeFileSync(existingFile, 'x');
    try {
      const mapped = buildGateGuardInput({
        agent_action_name: 'pre_write_code',
        trajectory_id: 'traj-1',
        tool_info: { file_path: existingFile },
      });
      assert.strictEqual(mapped.tool_name, 'Edit');
      assert.strictEqual(mapped.tool_input.file_path, existingFile);
    } finally {
      fs.rmSync(existingFile, { force: true });
    }
  })) passed++; else failed++;

  if (test('maps pre_run_command to a gateguard Bash input', () => {
    const mapped = buildGateGuardInput({
      agent_action_name: 'pre_run_command',
      trajectory_id: 'traj-1',
      tool_info: { command_line: 'echo hi', cwd: '/tmp' },
    });
    assert.deepStrictEqual(mapped, {
      session_id: 'traj-1',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    });
  })) passed++; else failed++;

  if (test('returns null for unmapped Windsurf events (pre_read_code, pre_mcp_tool_use, ...)', () => {
    assert.strictEqual(buildGateGuardInput({ agent_action_name: 'pre_read_code', tool_info: {} }), null);
    assert.strictEqual(buildGateGuardInput({ agent_action_name: 'pre_mcp_tool_use', tool_info: {} }), null);
  })) passed++; else failed++;

  if (test('returns null for pre_write_code with no file_path', () => {
    assert.strictEqual(
      buildGateGuardInput({ agent_action_name: 'pre_write_code', tool_info: {} }),
      null
    );
  })) passed++; else failed++;

  if (test('extractDenyReason reads hookSpecificOutput.permissionDecisionReason on deny', () => {
    const reason = extractDenyReason({
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' },
      }),
      exitCode: 0,
    });
    assert.strictEqual(reason, 'nope');
  })) passed++; else failed++;

  if (test('extractDenyReason returns null on allow (string passthrough)', () => {
    assert.strictEqual(extractDenyReason('{"tool_name":"Bash"}'), null);
  })) passed++; else failed++;

  if (test('extractDenyReason returns null when stdout is not JSON', () => {
    assert.strictEqual(extractDenyReason({ stdout: 'not json', exitCode: 0 }), null);
  })) passed++; else failed++;

  if (test('CLI: pre_write_code on a new file exits 2 with the fact-forcing reason on stderr', () => {
    const targetFile = path.join(os.tmpdir(), `windsurf-cli-new-${Date.now()}.js`);
    const result = runAdapterCli({
      agent_action_name: 'pre_write_code',
      trajectory_id: 'traj-cli-1',
      tool_info: { file_path: targetFile },
    });
    assert.strictEqual(result.code, 2);
    assert.ok(result.stderr.includes('Fact-Forcing Gate'));
    assert.ok(result.stderr.includes(targetFile));
    assert.strictEqual(result.stdout, '');
  })) passed++; else failed++;

  if (test('CLI: second pre_write_code call on the same file exits 0 with no output', () => {
    const targetFile = path.join(os.tmpdir(), `windsurf-cli-retry-${Date.now()}.js`);
    const event = {
      agent_action_name: 'pre_write_code',
      trajectory_id: 'traj-cli-2',
      tool_info: { file_path: targetFile },
    };
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windsurf-gateguard-retry-'));
    try {
      spawnSync('node', [adapterScript], {
        input: JSON.stringify(event),
        encoding: 'utf8',
        env: { ...process.env, GATEGUARD_STATE_DIR: stateDir },
      });
      const second = spawnSync('node', [adapterScript], {
        input: JSON.stringify(event),
        encoding: 'utf8',
        env: { ...process.env, GATEGUARD_STATE_DIR: stateDir },
      });
      assert.strictEqual(second.status, 0);
      assert.strictEqual(second.stderr, '');
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('CLI: pre_run_command exits 2 on first command in a session', () => {
    const result = runAdapterCli({
      agent_action_name: 'pre_run_command',
      trajectory_id: `traj-cli-bash-${Date.now()}`,
      tool_info: { command_line: 'ls', cwd: '/tmp' },
    });
    assert.strictEqual(result.code, 2);
    assert.ok(result.stderr.includes('Fact-Forcing Gate'));
  })) passed++; else failed++;

  if (test('CLI: unmapped event (pre_read_code) exits 0 with no output', () => {
    const result = runAdapterCli({
      agent_action_name: 'pre_read_code',
      trajectory_id: 'traj-cli-3',
      tool_info: { file_path: '/tmp/some-file.js' },
    });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(result.stderr, '');
  })) passed++; else failed++;

  if (test('CLI: malformed stdin JSON fails open (exit 0)', () => {
    const result = runAdapterCli('not json');
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
