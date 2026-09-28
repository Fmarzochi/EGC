/**
 * A stdio client for the built egc-memory server, shared by the tests that
 * drive it end to end: start it in a home and project of the test's own,
 * send requests and notifications, and stop it.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const MEMORY_SERVER = path.join(__dirname, '..', '..', 'mcp', 'servers', 'egc-memory', 'build', 'index.js');

function startMemoryServer({ home, projectDir, env = {} }) {
  const child = spawn(process.execPath, [MEMORY_SERVER], {
    cwd: projectDir,
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
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

async function initialize(server, clientName = 'memory-test') {
  const init = await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: clientName, version: '0' } });
  assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error)}`);
  server.notify('notifications/initialized', {});
}

async function callTool(server, name, args) {
  const response = await server.request('tools/call', { name, arguments: args });
  assert.ok(response.result, `${name} failed: ${JSON.stringify(response.error)}`);
  return (response.result.content || []).map(c => c.text || '').join('\n');
}

module.exports = { MEMORY_SERVER, startMemoryServer, initialize, callTool };
