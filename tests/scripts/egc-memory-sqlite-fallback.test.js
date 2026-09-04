/**
 * The MCP servers fall back to the portable sql.js engine when the native
 * sqlite3 binary cannot load (glibc older than the prebuilt requires). This
 * drives the built egc-memory server over stdio with the fallback forced and
 * proves the state survives a restart through the persisted file.
 * Skips with a clear message when the server has not been built yet.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_ROOT = path.join(__dirname, '../../mcp/servers/egc-memory');
const SERVER = path.join(SERVER_ROOT, 'build', 'index.js');
const COMPAT = path.join(SERVER_ROOT, 'build', 'sqlite-compat.js');

if (!fs.existsSync(SERVER) || !fs.existsSync(COMPAT)) {
  console.error(`[SKIP] Missing ${SERVER} or ${COMPAT}. Run 'npm ci && npm run build' in mcp/servers/egc-memory first.`);
  process.exit(0);
}

function startServer(home, projectDir, engine) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: projectDir,
    env: { ...process.env, HOME: home, USERPROFILE: home, EGC_SQLITE_ENGINE: engine, EGC_PROJECT: projectDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let exited = false;
  child.once('exit', () => { exited = true; });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}\n${stderr.slice(-800)}`)); }, 20000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const stop = () => new Promise(resolve => {
    if (exited) { resolve(); return; }
    child.once('exit', () => resolve());
    child.stdin.end();
    child.kill();
  });
  return { request, notify, stop, stderr: () => stderr };
}

async function initialize(server) {
  const init = await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fallback-test', version: '0' } });
  assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error)}`);
  server.notify('notifications/initialized', {});
}

async function callTool(server, name, args) {
  const response = await server.request('tools/call', { name, arguments: args });
  assert.ok(response.result, `${name} failed: ${JSON.stringify(response.error)}`);
  return (response.result.content || []).map(c => c.text || '').join('\n');
}

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
  console.log('\n=== Testing egc-memory sql.js fallback ===\n');
  let passed = 0;
  let failed = 0;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-fallback-home-'));
  const projectDir = path.join(home, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  try {
    if (await test('the server starts on the portable engine and lists its tools', async () => {
      const server = startServer(home, projectDir, 'wasm');
      try {
        await initialize(server);
        const tools = await server.request('tools/list', {});
        const names = tools.result.tools.map(t => t.name);
        assert.ok(names.includes('update_state') && names.includes('get_state'), names.join(','));
        assert.ok(fs.existsSync(path.join(home, '.egc', 'memory', 'state.db')), 'state.db must be created');
      } finally {
        await server.stop();
      }
    })) passed++; else failed++;

    if (await test('state written on the portable engine survives a restart', async () => {
      const first = startServer(home, projectDir, 'wasm');
      try {
        await initialize(first);
        await callTool(first, 'update_state', { project_path: projectDir, context: 'fallback engine roundtrip', decisions: [{ what: 'use the portable engine', why: 'native binary cannot load here' }] });
      } finally {
        await first.stop();
      }
      const second = startServer(home, projectDir, 'wasm');
      try {
        await initialize(second);
        const text = await callTool(second, 'get_state', { project_path: projectDir });
        assert.ok(text.includes('fallback engine roundtrip'), text.slice(0, 400));
        assert.ok(text.includes('use the portable engine'), text.slice(0, 400));
      } finally {
        await second.stop();
      }
    })) passed++; else failed++;

    if (await test('the native engine is still the default when it loads', async () => {
      let native = true;
      try { require('sqlite3'); } catch { native = false; }
      const server = startServer(home, projectDir, '');
      try {
        await initialize(server);
        const fellBack = server.stderr().includes('using the portable sql.js engine');
        assert.strictEqual(fellBack, !native, server.stderr().slice(-400));
        const state = await server.request('tools/call', { name: 'get_project_state', arguments: {} });
        const text = (state.result.content || []).map(c => c.text || '').join('');
        assert.ok(text.includes(native ? 'sqlite-wal' : 'sqlite-wasm'), text);
      } finally {
        await server.stop();
      }
    })) passed++; else failed++;

    // The previous test ran the native engine on this same state.db, so an
    // FTS5-capable engine has already written its virtual tables and sync
    // triggers into the file: exactly what a machine hits when the native
    // binary stops loading after an OS change.
    if (await test('a file written by the native engine still accepts decisions on the portable engine, and search_history answers by substring', async () => {
      const server = startServer(home, projectDir, 'wasm');
      try {
        await initialize(server);
        await callTool(server, 'store_decision', { project_path: projectDir, context: 'database engine', decision: 'portable engine keeps search alive' });
        const text = await callTool(server, 'search_history', { query: 'portable search' });
        assert.ok(text.includes('portable engine keeps search alive'), text.slice(0, 400));
        assert.ok(text.includes('"mode": "substring"'), text.slice(0, 400));
      } finally {
        await server.stop();
      }
    })) passed++; else failed++;

    if (await test('the substring search treats wildcards as text, keeps the FTS row shape and honours min_score', async () => {
      const server = startServer(home, projectDir, 'wasm');
      try {
        await initialize(server);
        await callTool(server, 'store_decision', { project_path: projectDir, context: 'metrics', decision: 'coverage stays at 100% or the gate fails' });
        const hit = JSON.parse(await callTool(server, 'search_history', { query: '100%' }));
        assert.strictEqual(hit.results.length, 1, JSON.stringify(hit).slice(0, 300));
        assert.ok(hit.results[0].content.includes('100%'));
        assert.ok('date' in hit.results[0] && 'score' in hit.results[0], 'same row shape as the FTS path');
        const miss = JSON.parse(await callTool(server, 'search_history', { query: '1__%' }));
        assert.strictEqual(miss.results.length, 0, 'wildcards must not match');
        const filtered = JSON.parse(await callTool(server, 'search_history', { query: '100%', min_score: 1 }));
        assert.strictEqual(filtered.results.length, 1, 'every substring match scores 1, so the top of the min_score range keeps it');
        assert.strictEqual(filtered.results[0].score, 1);
      } finally {
        await server.stop();
      }
    })) passed++; else failed++;

    if (await test('back on the native engine, the FTS5 index is rebuilt and finds the decision stored on the portable engine', async () => {
      let native = true;
      try { require('sqlite3'); } catch { native = false; }
      if (!native) {
        console.log('    - native sqlite3 does not load here; the rebuild path is not exercised');
        return;
      }
      const server = startServer(home, projectDir, '');
      try {
        await initialize(server);
        const text = await callTool(server, 'search_history', { query: 'portable' });
        assert.ok(text.includes('portable engine keeps search alive'), text.slice(0, 400));
        assert.ok(!text.includes('"mode": "substring"'), 'the FTS5 path must answer, not the substring fallback');
      } finally {
        await server.stop();
      }
    })) passed++; else failed++;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
