'use strict';
/**
 * The memory server opens its store before it accepts MCP requests. When
 * another process holds the store's lock at that moment (a second tool
 * starting at the same time, a migration in flight), the server waits for
 * the lock the way every later query does instead of exiting at startup.
 * Drives the built server over stdio; skips when the build or the native
 * driver is absent.
 *
 * Run with: node tests/egc-memory-startup-lock.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const serverDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory');
const SERVER = path.join(serverDir, 'build', 'index.js');
if (!fs.existsSync(SERVER)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-memory first.');
  process.exit(0);
}

let sqlite3;
try {
  sqlite3 = require(path.join(serverDir, 'node_modules', 'sqlite3'));
} catch {
  console.log('[SKIP] sqlite driver not installed. Run sh install.sh first.');
  process.exit(0);
}

// Long enough for a slow runner to reach the store before the lock goes,
// short enough to stay inside the server's 5000 ms busy timeout.
const LOCK_HELD_MS = 3000;
const ANSWER_BUDGET_MS = 20000;

function exec(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, err => (err ? reject(err) : resolve())));
}

function close(db) {
  return new Promise(resolve => db.close(() => resolve()));
}

// Starts the server on the given home and resolves with whether it answered
// the MCP initialize request.
function initialize(home) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, EGC_SQLITE_ENGINE: 'native' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    // Resolves only once the child is gone, so the cleanup that follows
    // never races a process still holding the store open.
    const done = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(result);
        return;
      }
      child.once('exit', () => resolve(result));
      child.kill();
    };
    const timer = setTimeout(() => done({ ok: false, why: `no answer in ${ANSWER_BUDGET_MS}ms: ${err.slice(-200)}` }), ANSWER_BUDGET_MS);
    child.stdout.on('data', chunk => {
      out += chunk;
      if (out.includes('"result"')) done({ ok: true });
    });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('exit', code => done({ ok: false, why: `exited with ${code}: ${(err.match(/SQLITE_\w+[^"\n]*/) || [err.slice(-200)])[0]}` }));
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'startup-lock-test', version: '0' } },
    }) + '\n');
  });
}

async function main() {
  console.log('\n=== Testing egc-memory startup against a held store lock ===\n');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-startup-lock-'));
  const dbDir = path.join(home, '.egc', 'memory');
  fs.mkdirSync(dbDir, { recursive: true });
  const holder = new sqlite3.Database(path.join(dbDir, 'state.db'));
  let failed = 0;
  try {
    await exec(holder, 'CREATE TABLE IF NOT EXISTS held (x INTEGER); BEGIN EXCLUSIVE; INSERT INTO held VALUES (1);');
    const started = initialize(home);
    setTimeout(() => { exec(holder, 'COMMIT').catch(() => {}); }, LOCK_HELD_MS);
    const result = await started;
    try {
      assert.ok(result.ok, result.why);
      console.log('  PASS the server waits for a store lock held at startup and then answers');
    } catch (error) {
      failed++;
      console.log('  FAIL the server waits for a store lock held at startup and then answers');
      console.log(`    ${error.message}`);
    }
  } finally {
    await close(holder);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(`\n${1 - failed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[FAIL]', err);
  process.exit(1);
});
