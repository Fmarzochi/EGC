'use strict';
/**
 * The rank_files tool is reachable over the MCP stdio server and returns the
 * ranking, the briefing and (on request) the explain lines as JSON.
 *
 * Run with: node tests/egc-guardian-filerank-tool.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CLI_TIMEOUT_MS } = require('./fixtures/subprocess-timeouts.js');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'index.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-filerank-tool-'));
const root = path.join(tmp, 'proj');
fs.mkdirSync(path.join(root, 'billing'), { recursive: true });
fs.writeFileSync(path.join(root, 'billing', 'payments.ts'), 'export function chargeCard() { return 1; }\n');
fs.writeFileSync(path.join(root, 'other.ts'), 'export const x = 1;\n');
const env = { ...process.env, EGC_DIR: path.join(tmp, 'egc-home') };

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.stack || err.message}`);
    failed++;
  }
}

function session() {
  const child = spawn(process.execPath, [path.join(buildDir, 'index.js')], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    }
  });
  const rpc = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), CLI_TIMEOUT_MS);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  // Resolves once the server is gone. On Windows a process that is still dying holds
  // the database under the temp tree open, and the tree cannot be removed under it.
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      child.once('exit', resolve);
      child.kill();
    });
  };
  return { child, rpc, stop };
}

async function open(s) {
  await s.rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  s.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
}

(async () => {
  await run('rank_files is listed with its input schema', async () => {
    const s = session();
    try {
      await open(s);
      const list = await s.rpc(2, 'tools/list', {});
      const tool = list.result.tools.find(t => t.name === 'rank_files');
      assert.ok(tool, 'rank_files listed');
      assert.deepStrictEqual(tool.inputSchema.required, ['query']);
      assert.ok(tool.inputSchema.properties.explain && tool.inputSchema.properties.project_path);
    } finally {
      await s.stop();
    }
  });

  await run('rank_files returns ranked files, a briefing, and explain lines on request', async () => {
    const s = session();
    try {
      await open(s);
      const res = await s.rpc(3, 'tools/call', { name: 'rank_files', arguments: { query: 'chargeCard', project_path: root, use_git: false, explain: true } });
      const body = JSON.parse(res.result.content[0].text);
      assert.strictEqual(body.ranked[0].path, 'billing/payments.ts');
      assert.ok(body.briefing.includes('[USER REQUEST]'));
      assert.ok(Array.isArray(body.explain) && body.explain[0].startsWith('explain:'));
    } finally {
      await s.stop();
    }
  });

  await run('rank_files without a query argument is rejected', async () => {
    const s = session();
    try {
      await open(s);
      const res = await s.rpc(4, 'tools/call', { name: 'rank_files', arguments: { project_path: root } });
      assert.ok(res.error || res.result.isError, 'rejected');
    } finally {
      await s.stop();
    }
  });

  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    console.log(`  FAIL removing ${tmp}: ${err.message}`);
    failed++;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
