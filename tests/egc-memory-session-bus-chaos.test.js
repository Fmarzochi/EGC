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
  process.stdin.on('end', () => {
    process.exit(0);
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
    this.proc.stdin.write(`${JSON.stringify({ type: 'resume', id, phase })}\n`);
  }

  async sigkill() {
    if (this.exited) return;
    const exited = new Promise(resolve => this.proc.once('exit', resolve));
    this.proc.kill('SIGKILL');
    await exited;
  }

  async close() {
    if (this.exited) return;
    try {
      await this.command('close');
    } catch {
      if (!this.exited) this.proc.kill('SIGTERM');
    }
  }
}

class Scenario {
  constructor(root, busModule, name) {
    this.dir = fs.mkdtempSync(path.join(root, `${name}-`));
    this.dbPath = path.join(this.dir, 'state.db');
    this.busModule = busModule;
    this.workers = [];
  }

  async init(bus) {
    const db = await openBusDb(this.dbPath);
    try {
      await bus.createSessionBusTables(db);
    } finally {
      await db.close();
    }
  }

  async worker(name) {
    const worker = new WorkerClient({ name, dbPath: this.dbPath, busModule: this.busModule });
    this.workers.push(worker);
    await worker.ready;
    return worker;
  }

  async inspect(fn) {
    const db = await openBusDb(this.dbPath);
    try {
      return await fn(db);
    } finally {
      await db.close();
    }
  }

  async close() {
    await Promise.all(this.workers.map(worker => worker.close()));
  }
}

function eventPayloads(events) {
  return events.map(event => String(event.payload));
}

async function drainEvents(worker, sessionId, projectPath) {
  const all = [];
  for (;;) {
    const batch = await worker.command('events', { sessionId, projectPath });
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

async function sendSequence(worker, senderId, projectPath, prefix, start, count) {
  for (let i = start; i < start + count; i++) {
    const payload = `${prefix}:${String(i).padStart(3, '0')}`;
    const result = await worker.command('send', {
      fromSession: senderId,
      projectPath,
      kind: 'chaos-load',
      payload
    });
    assert.strictEqual(result.ok, true, `${prefix} send ${i} refused: ${result.reason || 'unknown reason'}`);
  }
}

async function runHarness() {
  if (process.platform !== 'linux') {
    console.log('[SKIP] #1254 chaos harness is Linux-only (requires SIGKILL semantics).');
    return;
  }

  const ts = loadTypescript();
  if (!ts) {
    console.log('[SKIP] #1254 chaos harness could not resolve TypeScript from the repo root or egc-memory server install.');
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-session-bus-chaos-'));
  try {
    await runHarnessInTemp(tempRoot, ts);
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[WARN] failed to remove chaos temp directory: ${error.message}`);
    }
  }
}

async function runHarnessInTemp(tempRoot, ts) {
  const busModule = compileProductionBus(tempRoot, ts);
  const bus = require(busModule);
  const results = [];
  const metrics = {};

  async function run(name, fn) {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail });
      console.log(`  PASS ${name}${detail ? `  [${detail}]` : ''}`);
    } catch (error) {
      results.push({ name, ok: false, detail: error.message });
      console.log(`  FAIL ${name}`);
      console.log(`    ${error.stack || error}`);
    }
  }

  console.log('\n=== egc-memory session bus multi-process chaos harness ===\n');

  await run('simultaneous path claim has exactly one winner and names the holder', async () => {
    const scenario = new Scenario(tempRoot, busModule, 'claim');
    await scenario.init(bus);
    try {
      const [a, b] = await Promise.all([scenario.worker('claim-a'), scenario.worker('claim-b')]);
      await Promise.all([
        a.command('announce', { sessionId: 'claim-a', projectPath: '/chaos', territory: 'left' }),
        b.command('announce', { sessionId: 'claim-b', projectPath: '/chaos', territory: 'right' })
      ]);

      const ca = a.start('claim', { sessionId: 'claim-a', path: 'src/shared.js', ttlSeconds: 30 }, 'before-lock-insert');
      const cb = b.start('claim', { sessionId: 'claim-b', path: 'src/shared.js', ttlSeconds: 30 }, 'before-lock-insert');
      await Promise.all([
        a.waitForPhase(ca.id, 'before-lock-insert'),
        b.waitForPhase(cb.id, 'before-lock-insert')
      ]);
      a.resume(ca.id, 'before-lock-insert');
      b.resume(cb.id, 'before-lock-insert');
      const [ra, rb] = await Promise.all([ca.result, cb.result]);
      const winners = [
        { id: 'claim-a', result: ra },
        { id: 'claim-b', result: rb }
      ].filter(entry => entry.result.ok);
      assert.strictEqual(winners.length, 1, `expected one winner, got ${JSON.stringify({ ra, rb })}`);
      const winner = winners[0];
      const loser = winner.id === 'claim-a' ? rb : ra;
      assert.strictEqual(loser.ok, false);
      assert.strictEqual(loser.holder, winner.id, `loser did not identify holder: ${JSON.stringify(loser)}`);
      return `winner=${winner.id}`;
    } finally {
      await scenario.close();
    }
  });

  await run('overlapping readers consume each event exactly once per receiving session', async () => {
    const scenario = new Scenario(tempRoot, busModule, 'overlap');
    await scenario.init(bus);
    try {
      const [sender, readerA, readerB] = await Promise.all([
        scenario.worker('overlap-sender'),
        scenario.worker('overlap-reader-a'),
        scenario.worker('overlap-reader-b')
      ]);
      await sender.command('announce', { sessionId: 'sender', projectPath: '/chaos' });
      await readerA.command('announce', { sessionId: 'receiver', projectPath: '/chaos' });
      await readerB.command('announce', { sessionId: 'receiver', projectPath: '/chaos' });

      const expected = [];
      for (let i = 0; i < 12; i++) {
        const payload = `overlap:${i}`;
        expected.push(payload);
        const sent = await sender.command('send', {
          fromSession: 'sender',
          projectPath: '/chaos',
          kind: 'overlap',
          payload
        });
        assert.strictEqual(sent.ok, true);
      }

      const readA = readerA.start('events', { sessionId: 'receiver', projectPath: '/chaos' }, 'after-event-select');
      const readB = readerB.start('events', { sessionId: 'receiver', projectPath: '/chaos' }, 'after-event-select');
      const [selectedA, selectedB] = await Promise.all([
        readerA.waitForPhase(readA.id, 'after-event-select'),
        readerB.waitForPhase(readB.id, 'after-event-select')
      ]);
      assert.deepStrictEqual(selectedA.selected, selectedB.selected, 'barrier did not force both readers onto the same cursor snapshot');
      readerA.resume(readA.id, 'after-event-select');
      readerB.resume(readB.id, 'after-event-select');
      const [eventsA, eventsB] = await Promise.all([readA.result, readB.result]);
      const payloadsA = eventPayloads(eventsA);
      const payloadsB = eventPayloads(eventsB);
      const all = [...payloadsA, ...payloadsB];
      const counts = new Map();
      for (const payload of all) counts.set(payload, (counts.get(payload) || 0) + 1);
      const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([payload]) => payload);
      const missing = expected.filter(payload => !counts.has(payload));
      assert.deepStrictEqual(missing, [], `events lost across overlapping readers: ${missing.join(', ')}`);
      assert.deepStrictEqual(duplicates, [], `events delivered more than once to one receiving session: ${duplicates.join(', ')}`);
      assert.strictEqual(all.length, expected.length, `expected ${expected.length} total deliveries, got ${all.length}`);
      return `${expected.length} events`;
    } finally {
      await scenario.close();
    }
  });

  await run('SIGKILLed lock holder is released by TTL and heartbeat sweep removes the dead session', async () => {
    const scenario = new Scenario(tempRoot, busModule, 'sigkill-lock');
    await scenario.init(bus);
    try {
      const holder = await scenario.worker('lock-holder');
      const janitor = await scenario.worker('lock-janitor');
      await holder.command('announce', { sessionId: 'dead-holder', projectPath: '/chaos', territory: 'src/' });
      const claim = await holder.command('claim', { sessionId: 'dead-holder', path: 'src/owned.js', ttlSeconds: 1 });
      assert.strictEqual(claim.ok, true);
      const killedAt = Date.now();
      await holder.sigkill();

      await pollUntil(async () => {
        await janitor.command('sweep', {});
        const locks = await janitor.command('locks');
        return locks.every(lock => lock.path !== 'src/owned.js');
      }, { timeoutMs: 3000, label: 'dead holder lock TTL' });
      metrics.lockReleaseMs = Date.now() - killedAt;
      assert.ok(metrics.lockReleaseMs < 3000, `lock survived ${metrics.lockReleaseMs}ms after SIGKILL`);

      const future = Date.now() + (bus.SESSION_TTL_SECONDS + 1) * 1000;
      await janitor.command('sweep', {}, future);
      const peers = await janitor.command('peers', { projectPath: '/chaos' });
      assert.ok(!peers.some(peer => peer.id === 'dead-holder'), 'heartbeat sweep retained SIGKILLed session');

      const successor = await scenario.worker('lock-successor');
      await successor.command('announce', { sessionId: 'successor', projectPath: '/chaos' });
      const reclaimed = await successor.command('claim', { sessionId: 'successor', path: 'src/owned.js', ttlSeconds: 5 });
      assert.strictEqual(reclaimed.ok, true, 'expired lock was not reclaimable');
      return `release=${metrics.lockReleaseMs}ms`;
    } finally {
      await scenario.close();
    }
  });

  await run('writer death at the INSERT boundary creates no phantom and loses no committed event', async () => {
    const scenario = new Scenario(tempRoot, busModule, 'writer-death');
    await scenario.init(bus);
    try {
      const receiver = await scenario.worker('death-receiver');
      await receiver.command('announce', { sessionId: 'receiver', projectPath: '/chaos' });

      const preCommit = await scenario.worker('death-precommit');
      await preCommit.command('announce', { sessionId: 'writer-pre', projectPath: '/chaos' });
      const before = preCommit.start('send', {
        fromSession: 'writer-pre',
        projectPath: '/chaos',
        kind: 'death-before',
        payload: 'must-not-appear'
      }, 'before-event-insert');
      const beforeResult = before.result.catch(() => null);
      await preCommit.waitForPhase(before.id, 'before-event-insert');
      await preCommit.sigkill();
      await beforeResult;
      const phantomCount = await scenario.inspect(db => db.get("SELECT COUNT(*) AS n FROM bus_events WHERE payload = 'must-not-appear'"));
      assert.strictEqual(Number(phantomCount.n), 0, 'event partially appeared when writer died before INSERT');

      const postCommit = await scenario.worker('death-postcommit');
      await postCommit.command('announce', { sessionId: 'writer-post', projectPath: '/chaos' });
      const after = postCommit.start('send', {
        fromSession: 'writer-post',
        projectPath: '/chaos',
        kind: 'death-after',
        payload: 'must-survive'
      }, 'after-event-insert');
      const afterResult = after.result.catch(() => null);
      const committed = await postCommit.waitForPhase(after.id, 'after-event-insert');
      assert.ok(committed.lastID > 0, 'INSERT did not produce an event id before kill');
      await postCommit.sigkill();
      await afterResult;

      const persisted = await scenario.inspect(db => db.get("SELECT COUNT(*) AS n FROM bus_events WHERE payload = 'must-survive'"));
      assert.strictEqual(Number(persisted.n), 1, 'committed event disappeared after writer SIGKILL');
      const received = await drainEvents(receiver, 'receiver', '/chaos');
      const survivors = eventPayloads(received).filter(payload => payload === 'must-survive');
      assert.deepStrictEqual(survivors, ['must-survive'], 'receiver did not consume committed event exactly once');
      return `event=${committed.lastID}`;
    } finally {
      await scenario.close();
    }
  });

  await run('four concurrent writers preserve all events and per-sender order for early and late readers', async () => {
    const scenario = new Scenario(tempRoot, busModule, 'writers');
    await scenario.init(bus);
    try {
      const early = await scenario.worker('early-reader');
      await early.command('announce', { sessionId: 'early', projectPath: '/chaos' });
      const writers = await Promise.all(Array.from({ length: 4 }, (_, i) => scenario.worker(`writer-${i}`)));
      await Promise.all(writers.map((writer, i) => writer.command('announce', { sessionId: `writer-${i}`, projectPath: '/chaos' })));

      await Promise.all(writers.map((writer, i) => sendSequence(writer, `writer-${i}`, '/chaos', `w${i}`, 0, 5)));
      const late = await scenario.worker('late-reader');
      await late.command('announce', { sessionId: 'late', projectPath: '/chaos' });
      await Promise.all(writers.map((writer, i) => sendSequence(writer, `writer-${i}`, '/chaos', `w${i}`, 5, 10)));

      const [earlyEvents, lateEvents] = await Promise.all([
        drainEvents(early, 'early', '/chaos'),
        drainEvents(late, 'late', '/chaos')
      ]);
      assert.strictEqual(earlyEvents.length, 60, `early reader expected 60, got ${earlyEvents.length}`);
      assert.strictEqual(lateEvents.length, 40, `late reader expected only post-join 40, got ${lateEvents.length}`);
      assert.strictEqual(new Set(eventPayloads(earlyEvents)).size, 60, 'early reader saw duplicate payloads');
      assert.strictEqual(new Set(eventPayloads(lateEvents)).size, 40, 'late reader saw duplicate payloads');

      for (let writer = 0; writer < 4; writer++) {
        const earlySeq = eventPayloads(earlyEvents)
          .filter(payload => payload.startsWith(`w${writer}:`))
          .map(payload => Number(payload.split(':')[1]));
        const lateSeq = eventPayloads(lateEvents)
          .filter(payload => payload.startsWith(`w${writer}:`))
          .map(payload => Number(payload.split(':')[1]));
        assert.deepStrictEqual(earlySeq, Array.from({ length: 15 }, (_, i) => i), `writer ${writer} order changed for early reader`);
        assert.deepStrictEqual(lateSeq, Array.from({ length: 10 }, (_, i) => i + 5), `writer ${writer} order changed for late reader`);
      }
      return '4 writers / 60 events';
    } finally {
      await scenario.close();
    }
  });

  const passed = results.filter(result => result.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (metrics.lockReleaseMs !== undefined) console.log(`lock release after SIGKILL: ${metrics.lockReleaseMs}ms`);
  if (failed > 0) {
    console.log('\nInvariant violations are intentional hard failures for #1254; do not mask them as expected failures.');
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

if (IS_WORKER) {
  workerMain().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
  });
} else {
  runHarness().catch(error => {
    console.error('[FAIL] chaos harness crashed:', error.stack || error);
    process.exit(1);
  });
}