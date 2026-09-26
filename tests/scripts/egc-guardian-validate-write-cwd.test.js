/**
 * validate_write judges a relative path in the directory the agent works in
 * when the caller passes it as cwd, not in the directory the guardian server
 * happened to start in. Drives the built guardian over stdio in a synthetic
 * HOME, with the server started outside that HOME; skips when it has not
 * been built.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const SERVER = path.join(__dirname, '../../mcp/servers/egc-guardian/build/index.js');
if (!fs.existsSync(SERVER)) {
  console.error(`[SKIP] Missing ${SERVER}. Run 'npm ci && npm run build' in mcp/servers/egc-guardian first.`);
  process.exit(0);
}

function startServer(home, serverDir) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.EGC_LLM_ROUTING;
  const child = spawn(process.execPath, [SERVER], { cwd: serverDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let stderr = '';
  let exited = false;
  const pending = new Map();
  child.once('exit', () => { exited = true; });
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
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}\n${stderr.slice(-600)}`)); }, CLI_TIMEOUT_MS);
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

function verdictOf(response) {
  assert.ok(response.result, JSON.stringify(response.error));
  return response.result.content[0].text;
}

// Paths land in the log as JSON strings, where a Windows backslash is doubled.
function asLogged(p) {
  return JSON.stringify(p).slice(1, -1);
}

async function runTests() {
  console.log('\n=== Testing validate_write with the agent cwd over stdio ===\n');
  let passed = 0;
  let failed = 0;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-guardian-home-'));
  const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-guardian-server-'));
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  const server = startServer(home, serverDir);
  const validateWrite = args => server.request('tools/call', { name: 'validate_write', arguments: args });
  try {
    const init = await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'validate-write-cwd-test', version: '0' } });
    assert.ok(init.result, JSON.stringify(init.error));
    server.notify('notifications/initialized', {});

    if (await test('validate_write lists cwd among its arguments', async () => {
      const listed = await server.request('tools/list', {});
      const tool = listed.result.tools.find(t => t.name === 'validate_write');
      assert.ok(tool, 'validate_write is listed');
      assert.strictEqual(tool.inputSchema.properties.cwd.type, 'string');
      assert.deepStrictEqual(tool.inputSchema.required, ['filepath']);
    })) passed++; else failed++;

    if (await test('../.ssh/authorized_keys from a project in the home is denied', async () => {
      const text = verdictOf(await validateWrite({ filepath: '../.ssh/authorized_keys', cwd: project }));
      assert.ok(text.startsWith('[DENIED]'), text);
    })) passed++; else failed++;

    if (await test('the same path without a cwd is judged in the server directory', async () => {
      const text = verdictOf(await validateWrite({ filepath: '../.ssh/authorized_keys' }));
      assert.strictEqual(text, '[ALLOWED]');
    })) passed++; else failed++;

    if (await test('a null cwd reads as no cwd', async () => {
      const text = verdictOf(await validateWrite({ filepath: '../.ssh/authorized_keys', cwd: null }));
      assert.strictEqual(text, '[ALLOWED]');
    })) passed++; else failed++;

    if (await test('an allowed write is logged with the path resolved against the cwd', async () => {
      const text = verdictOf(await validateWrite({ filepath: 'notes.md', cwd: project }));
      assert.strictEqual(text, '[ALLOWED]');
      assert.ok(server.stderr().includes(asLogged(path.join(project, 'notes.md'))), server.stderr().slice(-600));
    })) passed++; else failed++;

    if (await test('a filepath written with ~ is logged under the home', async () => {
      const text = verdictOf(await validateWrite({ filepath: '~/project/todo.md', cwd: serverDir }));
      assert.strictEqual(text, '[ALLOWED]');
      assert.ok(server.stderr().includes(asLogged(path.join(project, 'todo.md'))), server.stderr().slice(-600));
    })) passed++; else failed++;

    if (await test('a denied write is audited with the path resolved against the cwd', async () => {
      const text = verdictOf(await validateWrite({ filepath: 'id_rsa', cwd: path.join(home, '.ssh') }));
      assert.ok(text.startsWith('[DENIED]'), text);
      const audit = fs.readFileSync(path.join(home, '.egc', 'audit.log'), 'utf8');
      assert.ok(audit.includes(asLogged(path.join(home, '.ssh', 'id_rsa'))), audit.slice(-600));
    })) passed++; else failed++;
  } finally {
    await server.stop();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(serverDir, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
