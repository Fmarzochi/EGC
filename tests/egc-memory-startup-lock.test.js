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
const { CLI_TIMEOUT_MS } = require('./fixtures/subprocess-timeouts');

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

// The native driver already waits 1000 ms for a lock on its own, so the
// lock is held longer than that once the server is at the store, and well
// inside the server's 5000 ms busy timeout. Where /proc exists the hold
// starts when the server's process holds the store open; elsewhere a fixed
// hold from spawn stands in for that proof.
const HAS_PROC_FDS = fs.existsSync('/proc/self/fd');
const HOLD_AFTER_OPEN_MS = 2000;
const FIXED_HOLD_MS = 3000;
const POLL_MS = 50;
// The probe gives up well before the answer budget, so the probe, the hold
// and the answer never overlap: at worst 10 s of probing and a fixed hold.
const PROBE_BUDGET_MS = 10000;

function exec(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, err => (err ? reject(err) : resolve())));
}

function close(db) {
  return new Promise(resolve => db.close(() => resolve()));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function holdsStoreOpen(pid) {
  const fdDir = `/proc/${pid}/fd`;
  try {
    return fs.readdirSync(fdDir).some(fd => {
      try { return fs.readlinkSync(path.join(fdDir, fd)).endsWith(`${path.sep}state.db`); } catch { return false; }
    });
  } catch {
    return false;
  }
}

// Starts the server on the given home. `answered` resolves with whether it
// answered the MCP initialize request, and only once the process is gone,
// so the cleanup that follows never races a process holding the store.
function startServer(home) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, EGC_SQLITE_ENGINE: 'native' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const server = { child, settled: false };
  let out = '';
  let err = '';
  server.answered = new Promise(resolve => {
    const done = result => {
      if (server.settled) return;
      server.settled = true;
      clearTimeout(timer);
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(result);
        return;
      }
      child.once('exit', () => resolve(result));
      child.kill();
    };
    const timer = setTimeout(() => done({ ok: false, why: `no answer in ${CLI_TIMEOUT_MS}ms: ${err.slice(-200)}` }), CLI_TIMEOUT_MS);
    child.stdout.on('data', chunk => {
      out += chunk;
      if (out.includes('"result"')) done({ ok: true });
    });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('exit', code => done({ ok: false, why: `exited with ${code}: ${(err.match(/SQLITE_\w+[^"\n]*/) || [err.slice(-200)])[0]}` }));
  });
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'startup-lock-test', version: '0' } },
  }) + '\n');
  return server;
}

// Resolves once the lock has been held long enough, or the server has
// finished. When the probe cannot see the store open in time, the fixed
// hold takes over.
async function waitUntilAtStore(server) {
  if (HAS_PROC_FDS) {
    const deadline = Date.now() + PROBE_BUDGET_MS;
    while (!server.settled && Date.now() < deadline) {
      if (holdsStoreOpen(server.child.pid)) {
        await sleep(HOLD_AFTER_OPEN_MS);
        return;
      }
      await sleep(POLL_MS);
    }
    if (server.settled) return;
  }
  await sleep(FIXED_HOLD_MS);
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
    const server = startServer(home);
    await waitUntilAtStore(server);
    const waitingAtRelease = !server.settled;
    await exec(holder, 'COMMIT');
    const result = await server.answered;
    try {
      assert.ok(waitingAtRelease, `the server had already finished before the lock was released: ${result.why || 'answered'}`);
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
