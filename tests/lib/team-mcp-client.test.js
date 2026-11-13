/**
 * Tests for scripts/lib/team-mcp-client.js: the one-call MCP session the
 * team CLI holds with the memory server, run against fake servers that
 * answer, refuse, exit early or never answer.
 *
 * Run with: node tests/lib/team-mcp-client.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { callMcpTool } = require('../../scripts/lib/team-mcp-client');

// A stand-in for the memory server: it speaks the handshake the client
// sends and then behaves as EGC_FAKE_MODE says.
const FAKE_SERVER = `
'use strict';
const readline = require('node:readline');
const mode = process.env.EGC_FAKE_MODE || 'answers';
const reply = message => process.stdout.write(JSON.stringify(message) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') {
    reply({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0' } } });
    return;
  }
  if (request.method !== 'tools/call') return;
  const name = request.params.name;
  if (mode === 'exits') {
    process.stderr.write('[memory] store: cannot open /nowhere/state.db\\n');
    process.exit(3);
  }
  if (mode === 'hangs') {
    process.stderr.write('[memory] git: Host key verification pending\\n');
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'refuses') {
    reply({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: 'The remote x cannot be read: refused' }] } });
    return;
  }
  if (mode === 'textless') {
    reply({ jsonrpc: '2.0', id: request.id, result: { content: [] } });
    return;
  }
  process.stderr.write('[memory] a log line that is not a failure\\n');
  reply({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name, args: request.params.arguments, mark: process.env.EGC_TEST_MARK ?? null }) }] } });
});
rl.on('close', () => process.exit(0));
`;

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

async function runTests() {
  console.log('\n=== Testing team-mcp-client ===\n');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-team-mcp-client-'));
  const serverScript = path.join(tempDir, 'fake-server.js');
  fs.writeFileSync(serverScript, FAKE_SERVER);
  const call = (tool, args, mode, extra = {}) => callMcpTool(tool, args, {
    serverScript,
    env: { ...process.env, EGC_FAKE_MODE: mode, ...extra.env },
    timeoutMs: extra.timeoutMs,
  });

  try {
    await test('an answer comes back parsed, with the arguments the call sent and the environment the caller gave', async () => {
      const value = await call('team_status', { verbose: true }, 'answers', { env: { EGC_TEST_MARK: 'given' } });
      assert.deepStrictEqual(value, { ok: true, tool: 'team_status', args: { verbose: true }, mark: 'given' });
    });

    await test('a refusal by the tool rejects with the refusal and isToolError', async () => {
      await assert.rejects(
        () => call('team_init', {}, 'refuses'),
        error => error.isToolError === true && error.message === 'The remote x cannot be read: refused',
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

    await test('an answer without a text result is a failure that names the tool', async () => {
      await assert.rejects(
        () => call('team_status', {}, 'textless'),
        /^Error: The memory server answered team_status without a text result$/,
      );
    });

    await test('a server script that does not exist rejects with the exit instead of hanging', async () => {
      await assert.rejects(
        () => callMcpTool('team_status', {}, { serverScript: path.join(tempDir, 'missing.js'), timeoutMs: 5000 }),
        error => {
          assert.ok(!error.isTimeout, 'a missing script is an exit, not a timeout');
          assert.match(error.message, /^The memory server exited with code 1 before answering team_status; the server wrote: /);
          return true;
        },
      );
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
