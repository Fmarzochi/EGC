'use strict';
/**
 * Multi-process chaos harness for the egc-memory session bus (#1254).
 *
 * Linux-only by design: the mission requires SIGKILL semantics. The harness
 * runs against the production session-bus.ts source, transpiled in a temporary
 * directory with a TypeScript compiler resolved from the repo root or egc-memory
 * server install, and uses the same sqlite / sqlite3
 * drivers installed by the repository's normal `npm ci`.
 *
 * Synchronization is barrier-based. No fixed sleeps are used to make races
 * happen; the only timers are bounded polling deadlines for TTL expiry and
 * process/RPC safety.
 */
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IS_WORKER = process.argv.includes('--chaos-worker');
const REPO_ROOT = path.resolve(__dirname, '..');
const EGC_MEMORY_ROOT = path.join(REPO_ROOT, 'mcp', 'servers', 'egc-memory');
const SESSION_BUS_SOURCE = path.join(EGC_MEMORY_ROOT, 'src', 'session-bus.ts');
const MODULE_RESOLVE_PATHS = [REPO_ROOT, EGC_MEMORY_ROOT];
const RPC_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 25;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollUntil(fn, { timeoutMs, intervalMs = POLL_INTERVAL_MS, label }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    last = await fn();
    if (last) return last;
    await delay(intervalMs);
  }
  throw new Error(`deadline exceeded while polling ${label || 'condition'}`);
}

function loadSqlite() {
  // Root CI installs these before tests/run-all.js. Requiring by package name
  // makes this harness independent from the nested MCP build/node_modules.
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  return { sqlite3, open };
}

async function openBusDb(dbPath) {
  const { sqlite3, open } = loadSqlite();
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec('PRAGMA synchronous = NORMAL;');
  await db.exec('PRAGMA foreign_keys = ON;');
  await db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

function loadTypescript() {
  try {
    return require(require.resolve('typescript', { paths: MODULE_RESOLVE_PATHS }));
  } catch {
    return null;
  }
}

function compileProductionBus(tempDir, ts) {
  const source = fs.readFileSync(SESSION_BUS_SOURCE, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: SESSION_BUS_SOURCE,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    }
  });
  const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const text = errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n');
    throw new Error(`failed to transpile production session-bus.ts:\n${text}`);
  }
  const output = path.join(tempDir, 'session-bus.production.cjs');
  fs.writeFileSync(output, result.outputText, 'utf8');
  return output;
}

function phaseKey(id, phase) {
  return `${id}:${phase}`;
}

async function workerMain() {
  const busPath = process.env.EGC_CHAOS_BUS_MODULE;
  const dbPath = process.env.EGC_CHAOS_DB;
  if (!busPath || !dbPath) throw new Error('chaos worker missing module/database environment');

  const bus = require(busPath);
  const db = await openBusDb(dbPath);
  const resumeWaiters = new Map();
  let inputBuffer = '';

  const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);

  function waitForResume(id, phase) {
    return new Promise(resolve => resumeWaiters.set(phaseKey(id, phase), resolve));
  }

  async function signalBarrier(id, phase, detail = {}) {
    send({ type: 'phase', id, phase, ...detail });
    await waitForResume(id, phase);
  }

  function dbForCommand(command) {
    const barrier = command.barrier;
    return {
      exec: db.exec.bind(db),
      get: db.get.bind(db),
      all: async (sql, ...params) => {
        const rows = await db.all(sql, ...params);
        if (command.op === 'events' && barrier === 'after-event-select' && /FROM\s+bus_events/i.test(sql)) {
          await signalBarrier(command.id, barrier, { selected: rows.map(row => Number(row.id)) });
        }
        return rows;
      },
      run: async (sql, ...params) => {
        const isEventInsert = /INSERT\s+INTO\s+bus_events/i.test(sql);
        const isLockInsert = /INSERT\s+OR\s+IGNORE\s+INTO\s+bus_locks/i.test(sql);
        if (isLockInsert && barrier === 'before-lock-insert') {
          await signalBarrier(command.id, barrier);
        }
        if (isEventInsert && barrier === 'before-event-insert') {
          await signalBarrier(command.id, barrier);
        }
        const result = await db.run(sql, ...params);
        if (isEventInsert && barrier === 'after-event-insert') {
          await signalBarrier(command.id, barrier, { lastID: Number(result?.lastID || 0) });
        }
        return result;
      }
    };
  }

  async function execute(command) {
    const commandDb = dbForCommand(command);
    switch (command.op) {
      case 'announce':
        await bus.announce(commandDb, command.args, command.nowMs);
        return true;
      case 'peers':
        return bus.listPeers(commandDb, command.args?.projectPath);
      case 'claim':
        return bus.claimPath(commandDb, command.args, command.nowMs);
      case 'release':
        return bus.releasePath(commandDb, command.args);
      case 'locks':
        return bus.listLocks(commandDb);
      case 'send':
        return bus.sendEvent(commandDb, command.args, command.nowMs);
      case 'events':
        return bus.readEvents(commandDb, command.args);
      case 'sweep':
        await bus.sweepDead(commandDb, command.nowMs);
        return true;
      case 'close':
        await db.close();
        return 'closed';
      default:
        throw new Error(`unknown worker op: ${command.op}`);
    }
  }

  function handleMessage(message) {
    if (message.type === 'resume') {
      const key = phaseKey(message.id, message.phase);
      const resolve = resumeWaiters.get(key);
      if (resolve) {
        resumeWaiters.delete(key);
        resolve();
      }
      return;
    }

    void execute(message).then(
      value => {
        send({ type: 'result', id: message.id, ok: true, value });
        if (message.op === 'close') process.exit(0);
      },
      error => send({ type: 'result', id: message.id, ok: false, error: error?.stack || String(error) })
    );
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    inputBuffer += chunk;
    let newline;
    while ((newline = inputBuffer.indexOf('\n')) >= 0) {
      const line = inputBuffer.slice(0, newline).trim();
      inputBuffer = inputBuffer.slice(newline + 1);
      if (!line) continue;
      handleMessage(JSON.parse(line));
    }
  });

  send({ type: 'ready', pid: process.pid });
}

class WorkerClient {
  constructor({ name, dbPath, busModule }) {
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.phaseWaiters = new Map();
    this.phaseBacklog = new Map();
    this.stderr = '';
    this.exited = false;
    this.buffer = '';
    this.proc = spawn(process.execPath, [__filename, '--chaos-worker'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        EGC_CHAOS_DB: dbPath,
        EGC_CHAOS_BUS_MODULE: busModule
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => this.onStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', chunk => { this.stderr += chunk; });
    this.proc.on('error', error => this.failAll(error));
    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      const error = new Error(`${this.name} exited code=${code} signal=${signal}${this.stderr ? ` stderr=${this.stderr.slice(-500)}` : ''}`);
      if (this.readyReject) this.readyReject(error);
      this.failAll(error);
    });
  }

  onStdout(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.type === 'ready') {
        this.pid = message.pid;
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
          this.readyReject = null;
        }
        continue;
      }
      if (message.type === 'phase') {
        const key = phaseKey(message.id, message.phase);
        const waiter = this.phaseWaiters.get(key);
        if (waiter) {
          this.phaseWaiters.delete(key);
          waiter.resolve(message);
        } else {
          this.phaseBacklog.set(key, message);
        }
        continue;
      }
      if (message.type === 'result') {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(`${this.name}: ${message.error}`));
      }
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.phaseWaiters.values()) waiter.reject(error);
    this.phaseWaiters.clear();
  }

  start(op, args = {}, barrier, nowMs) {
    if (this.exited) throw new Error(`${this.name} is not running`);
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: timeout on ${op}`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.proc.stdin.write(`${JSON.stringify({ id, op, args, barrier, nowMs })}\n`);
    return { id, result };
  }

  command(op, args = {}, nowMs) {
    return this.start(op, args, undefined, nowMs).result;
  }

  waitForPhase(id, phase) {
    const key = phaseKey(id, phase);
    const backlogged = this.phaseBacklog.get(key);
    if (backlogged) {
      this.phaseBacklog.delete(key);
      return Promise.resolve(backlogged);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.phaseWaiters.delete(key);
        reject(new Error(`${this.name}: timeout waiting for phase ${phase}`));
      }, RPC_TIMEOUT_MS);
      this.phaseWaiters.set(key, {
        resolve: message => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  resume(id, phase) {
    this.proc.stdin.write(`${JSON.stringify-Ê—«zË¦z'bv˜Z±êajÇ§jÌ§rÈ ’)e‰ûaŠÇ±Š×­ën®w(žË^Æ+^vw°>º&ŠÇ«zÊ%½