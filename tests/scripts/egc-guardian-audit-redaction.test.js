/**
 * validate_command's own audit trail (stderr and ~/.egc/logs) must never
 * carry the credentials embedded in the command it judged (security audit
 * 2026-08-17, F6). Drives the built guardian over stdio in a synthetic HOME;
 * skips when it has not been built.
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

const TOKEN = 'ghp_' + 'Q'.repeat(36);
const BEARER = 'abc.def.ghi';

function startServer(home, projectDir) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: projectDir,
    env: { ...process.env, HOME: home, USERPROFILE: home, EGC_PROJECT: projectDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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

async function runTests() {
  console.log('\n=== Testing guardian audit redaction over stdio ===\n');
  let passed = 0;
  let failed = 0;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-guardian-home-'));
  const server = startServer(home, home);
  try {
    const init = await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'redaction-test', version: '0' } });
    assert.ok(init.result, JSON.stringify(init.error));
    server.notify('notifications/initialized', {});

    const allowedCmd = `curl -H "Authorization: Bearer ${BEARER}" https://api.example.test/repos`;
    const deniedCmd = `find . -delete --token=${TOKEN}`;
    await server.request('tools/call', { name: 'validate_command', arguments: { command: allowedCmd } });
    const denied = await server.request('tools/call', { name: 'validate_command', arguments: { command: deniedCmd } });
    assert.ok(denied.result, JSON.stringify(denied.error));
    // The logger appends asynchronously after the tool has already answered:
    // wait for both entries to land on disk instead of guessing a delay.
    const sysLogPath = path.join(home, '.egc', 'logs', 'egc-guardian-router.log');
    const deadline = Date.now() + CLI_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const entries = fs.existsSync(sysLogPath) ? (fs.readFileSync(sysLogPath, 'utf8').match(/COMMAND_EXECUTION/g) || []).length : 0;
      if (entries >= 2 && fs.existsSync(path.join(home, '.egc', 'audit.log'))) break;
      await new Promise(r => setTimeout(r, 50));
    }

    if (await test('the stderr audit stream carries neither the bearer token nor the flag value', async () => {
      const err = server.stderr();
      assert.ok(err.includes('COMMAND_EXECUTION'), err.slice(-400));
      assert.ok(!err.includes(BEARER), 'bearer leaked to stderr');
      assert.ok(!err.includes(TOKEN), 'token leaked to stderr');
      assert.ok(err.includes('[REDACTED]'), err.slice(-400));
    })) passed++; else failed++;

    if (await test('the system log file and the denial audit log on disk are redacted too', async () => {
      const sysLog = path.join(home, '.egc', 'logs', 'egc-guardian-router.log');
      const auditLog = path.join(home, '.egc', 'audit.log');
      for (const file of [sysLog, auditLog]) {
        assert.ok(fs.existsSync(file), `${file} must exist`);
        const text = fs.readFileSync(file, 'utf8');
        assert.ok(!text.includes(BEARER) && !text.includes(TOKEN), `${file} leaks a credential`);
      }
      assert.ok(fs.readFileSync(auditLog, 'utf8').includes('[REDACTED]'));
    })) passed++; else failed++;

    if (await test('the tool answers are unaffected', async () => {
      const text = (denied.result.content || []).map(c => c.text).join('');
      assert.ok(text.startsWith('[DENIED]'), text);
    })) passed++; else failed++;
  } finally {
    await server.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
