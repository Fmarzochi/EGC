/**
 * The egc-memory server answers every tool it lists and refuses, as not
 * found, a name it does not list (a prototype key included). Drives the
 * built server over stdio in a home of its own.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MEMORY_SERVER, startMemoryServer, initialize, callTool } = require('../fixtures/memory-server-client');

const METHOD_NOT_FOUND = -32601;

if (!fs.existsSync(MEMORY_SERVER)) {
  console.log(`[SKIP] Missing ${MEMORY_SERVER}. Run 'npm ci && npm run build' in mcp/servers/egc-memory first.`);
  process.exit(0);
}

// Arguments that keep each call short and local: the wait returns at once,
// and team_init lacks its remote, so it is refused before it touches git.
const PROBE_ARGS = {
  session_wait: { timeout_ms: 100 },
};

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function runTests() {
  console.log('\n=== Testing egc-memory tool dispatch ===\n');
  let passed = 0;
  let failed = 0;
  const tally = ok => (ok ? passed++ : failed++);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-dispatch-home-'));
  const projectDir = path.join(home, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  const server = startMemoryServer({ home, projectDir, env: { EGC_PROJECT: projectDir } });

  try {
    await initialize(server, 'dispatch-test');
    const listed = (await server.request('tools/list', {})).result.tools.map(tool => tool.name);

    tally(await test('every tool the server lists is answered, not refused as unknown', async () => {
      assert.ok(listed.length >= 24, listed.join(','));
      for (const name of listed) {
        const response = await server.request('tools/call', { name, arguments: PROBE_ARGS[name] || {} });
        assert.notStrictEqual(response.error?.code, METHOD_NOT_FOUND, `${name}: ${JSON.stringify(response.error)}`);
      }
    }));

    tally(await test('a name the server does not list is refused as not found, a prototype key included', async () => {
      for (const name of ['no_such_tool', 'constructor', 'toString', 'hasOwnProperty', '__proto__', '']) {
        const response = await server.request('tools/call', { name, arguments: {} });
        assert.strictEqual(response.error?.code, METHOD_NOT_FOUND, `${JSON.stringify(name)}: ${JSON.stringify(response)}`);
      }
    }));

    tally(await test('working memory round-trips a value, and query_history returns a stored decision', async () => {
      await callTool(server, 'working_memory_set', { key: 'k1', value: 'v1' });
      assert.deepStrictEqual(JSON.parse(await callTool(server, 'working_memory_get', { key: 'k1' })).value, 'v1');
      assert.deepStrictEqual(JSON.parse(await callTool(server, 'working_memory_list', {})).map(entry => entry.key), ['k1']);
      assert.strictEqual(await callTool(server, 'working_memory_get', { key: 'missing' }), 'null');
      await callTool(server, 'store_decision', { context: 'dispatch test', decision: 'keep one map of handlers' });
      const history = JSON.parse(await callTool(server, 'query_history', { limit: 5 }));
      assert.ok(history.data.some(row => row.decision === 'keep one map of handlers'), JSON.stringify(history));
      assert.deepStrictEqual(history.meta, { limit: 5, offset: 0 });
    }));

    tally(await test('invalid arguments are refused as invalid parameters', async () => {
      const response = await server.request('tools/call', { name: 'team_init', arguments: {} });
      assert.strictEqual(response.error?.code, -32602, JSON.stringify(response));
      const state = JSON.parse(await callTool(server, 'get_project_state', {}));
      assert.strictEqual(state.status, 'active');
    }));
  } finally {
    await server.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
