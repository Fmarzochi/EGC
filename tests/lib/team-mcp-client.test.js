/**
 * Tests for scripts/lib/team-mcp-client.js: the one-call MCP session the
 * team CLI holds with the memory server, run against the fake server of
 * tests/fixtures/fake-memory-server.js in each of its modes.
 *
 * Run with: node tests/lib/team-mcp-client.test.js
 */

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');

const { callMcpTool } = require('../../scripts/lib/team-mcp-client');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'fake-memory-server.js');

const results = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    results.push(true);
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    results.push(false);
  }
}

const call = (tool, args, mode, extra = {}) => callMcpTool(tool, args, {
  serverScript: FIXTURE,
  env: { ...process.env, EGC_FAKE_MODE: mode, ...extra.env },
  timeoutMs: extra.timeoutMs,
  exitGraceMs: extra.exitGraceMs,
});

async function runTests() {
  console.log('\n=== Testing team-mcp-client ===\n');

  await test('an answer comes back parsed, with the arguments the call sent and the environment the caller gave', async () => {
    const value = await call('team_status', { verbose: true }, 'answers', { env: { EGC_TEST_MARK: 'given' } });
    assert.deepStrictEqual(value, { ok: true, tool: 'team_status', args: { verbose: true }, mark: 'given' });
  });

  await test('a text result that is not JSON comes back as text, and log lines on stdout are skipped', async () => {
    assert.strictEqual(await call('team_status', {}, 'raw-text'), 'plain words, not JSON');
    assert.deepStrictEqual(await call('team_status', {}, 'noisy'), { ok: true, noisy: true });
  });

  await test('a refusal by the tool and a JSON-RPC error on the call reject with isToolError', async () => {
    await assert.rejects(
      () => call('team_init', {}, 'refuses'),
      error => error.isToolError === true && error.message === 'The remote x cannot be read: refused',
    );
    await assert.rejects(
      () => call('team_sync', {}, 'rpc-error'),
      error => error.isToolError === true && error.message === 'Tool not found: team_sync',
    );
  });

  await test('a handshake the server refuses rejects with its message, neither a refusal of the tool nor a timeout', async () => {
    await assert.rejects(
      () => call('team_status', {}, 'init-error'),
      error => !error.isToolError && !error.isTimeout && error.message === 'this server refuses the handshake',
    );
  });

  await test('a server that exits before answering names its exit code and its last stderr lines', async () => {
    await assert.rejects(
      () => call('team_sync', {}, 'exits'),
      error => {
        assert.strictEqual(error.exitCode, 3);
        assert.ok(!error.isTimeout, 'an exit is not a timeout');
        assert.match(error.message, /^The memory server exited with code 3 before answering team_sync; the server wrote: \[memory\] store: cannot open \/nowhere\/state\.db$/);
        return true;
      },
    );
  });

  await test('a failure quotes the last three stderr lines only, whole, out of more stderr than the client keeps', async () => {
    await assert.rejects(
      () => call('team_sync', {}, 'chatty-exit'),
      error => {
        assert.match(error.message, /exited with code 2 before answering team_sync; the server wrote: \[memory\] line 28 x{180} \| \[memory\] line 29 x{180} \| \[memory\] line 30 x{180}$/);
        assert.ok(!error.message.includes('line 27'), 'earlier lines are left out');
        return true;
      },
    );
  });

  await test('a server stopped by a signal before answering names the signal', async () => {
    if (process.platform === 'win32') {
      console.log('    (skipped on Windows: no signals)');
      return;
    }
    await assert.rejects(
      () => call('team_sync', {}, 'self-kill'),
      error => {
        assert.strictEqual(error.signal, 'SIGTERM');
        assert.strictEqual(error.exitCode, null);
        assert.match(error.message, /^The memory server was stopped by SIGTERM before answering team_sync; the server wrote: \[memory\] stopped by a signal$/);
        return true;
      },
    );
  });

  await test('a grandchild that keeps the pipes open after the server exits does not hold the session', async () => {
    const started = Date.now();
    await assert.rejects(
      () => call('team_sync', {}, 'orphan', { timeoutMs: 10000 }),
      error => {
        assert.strictEqual(error.exitCode, 4);
        assert.match(error.message, /^The memory server exited with code 4 before answering team_sync; the server wrote: \[memory\] leaving a grandchild on the pipes$/);
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4000, `the session settled a moment after the exit, not when the grandchild left, took ${elapsed} ms`);
  });

  await test('a server that never answers rejects at the budget with isTimeout and what it wrote', async () => {
    const started = Date.now();
    await assert.rejects(
      () => call('team_sync', {}, 'hangs', { timeoutMs: 400 }),
      error => {
        assert.strictEqual(error.isTimeout, true);
        assert.match(error.message, /^The memory server did not answer team_sync within 0\.4 s; the server wrote: \[memory\] git: Host key verification pending$/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 10000, 'the hung server is stopped, not waited for');
  });

  await test('a hung server that ignores the first signal is killed a moment later', async () => {
    const started = Date.now();
    await assert.rejects(
      () => call('team_sync', {}, 'hangs-deaf', { timeoutMs: 400 }),
      error => error.isTimeout === true,
    );
    const elapsed = Date.now() - started;
    // Windows has no signal to ignore: kill() ends the process at once.
    const floor = process.platform === 'win32' ? 0 : 2000;
    assert.ok(elapsed >= floor && elapsed < 15000, `the kill follows the ignored signal, took ${elapsed} ms`);
  });

  await test('an answer stands when the server is slow to exit, even past the budget', async () => {
    const started = Date.now();
    const value = await call('team_status', {}, 'answers-linger', { timeoutMs: 300, exitGraceMs: 1200 });
    assert.deepStrictEqual(value, { ok: true, tool: 'team_status', args: {}, mark: null });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1150 && elapsed < 10000, `the lingering server is stopped after the exit grace, took ${elapsed} ms`);
  });

  await test('an answer without a text result is a failure that names the tool', async () => {
    await assert.rejects(
      () => call('team_status', {}, 'textless'),
      /^Error: The memory server answered team_status without a text result$/,
    );
  });

  await test('a server script that does not exist rejects with the exit instead of hanging', async () => {
    await assert.rejects(
      () => callMcpTool('team_status', {}, { serverScript: path.join(os.tmpdir(), 'egc-no-such-server.js'), timeoutMs: 5000 }),
      error => {
        assert.ok(!error.isTimeout, 'a missing script is an exit, not a timeout');
        assert.match(error.message, /^The memory server exited with code 1 before answering team_status; the server wrote: /);
        return true;
      },
    );
  });

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
