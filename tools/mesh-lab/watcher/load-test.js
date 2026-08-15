'use strict';
// Acceptance load test (#1252): 1,000 events pushed to 10 subscriber
// PROCESSES over the real store shape, with a WAL checkpoint (TRUNCATE)
// fired mid-run to prove delivery survives the rewrite. Asserts, for every
// subscriber: zero loss, zero duplicates, per-sender ordering, and no
// leaked fds; and globally: p95 delivery latency under 250ms while the
// writer stays busy. Prints the latency distribution for the PR report.

const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSqliteDriver } = require('./lib/deps');
const { openStore, insertEvent } = require('./lib/store');

const SUBSCRIBERS = 10;
const TOTAL_EVENTS = 1000;
const BURST_SIZE = 25;
const BURST_GAP_MS = 40;
const P95_BUDGET_MS = 250;

function spawnSubscriber(dbPath) {
  const child = fork(path.join(__dirname, 'subscriber.js'), [dbPath, 'top'], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  });
  const state = { child, deliveries: [], fd: null, error: null };
  state.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscriber not ready in 15s')), 15000);
    state.onReady = () => { clearTimeout(timer); resolve(); };
    state.onFatal = message => { clearTimeout(timer); reject(new Error(message)); };
  });
  state.stopped = new Promise(resolve => { state.onStopped = resolve; });
  child.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'ready') state.onReady();
    else if (msg.type === 'delivery') state.deliveries.push(msg);
    else if (msg.type === 'stopped') { state.fd = { baseline: msg.fdBaseline, final: msg.fdFinal }; state.onStopped(); }
    else if (msg.type === 'fatal') { state.error = msg.error; state.onFatal(msg.error); }
  });
  child.on('exit', () => state.onStopped());
  return state;
}

function receivedCount(state) {
  return state.deliveries.reduce((n, d) => n + d.events.length, 0);
}

async function pollUntil(predicate, deadlineMs, stepMs = 25) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
  return predicate();
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[index];
}

function distroLine() {
  try {
    const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
    const pretty = /PRETTY_NAME="([^"]+)"/.exec(osRelease);
    return pretty ? pretty[1] : os.release();
  } catch {
    return os.release();
  }
}

async function main() {
  const driver = loadSqliteDriver();
  if (!driver) {
    console.log('[SKIP] sqlite driver unavailable.');
    process.exit(0);
  }
  console.log(`\n--- load test: ${TOTAL_EVENTS} events -> ${SUBSCRIBERS} subscriber processes ---`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-mesh-load-'));
  const dbPath = path.join(dir, 'state.db');
  const subscribers = [];
  let failures = 0;
  let db = null;
  try {
    db = await openStore(driver, dbPath);
    for (let i = 0; i < SUBSCRIBERS; i++) subscribers.push(spawnSubscriber(dbPath));
    await Promise.all(subscribers.map(s => s.ready));

    const bursts = TOTAL_EVENTS / BURST_SIZE;
    const checkpointAt = Math.floor(bursts / 2);
    let checkpointResult = null;
    let seq = 0;
    for (let burst = 0; burst < bursts; burst++) {
      if (burst === checkpointAt) {
        // The mid-run rewrite the mission calls out: naive watchers die
        // here. TRUNCATE reports busy=1 without throwing when readers hold
        // the WAL, so the result is captured and asserted below: an
        // unverified checkpoint would let this acceptance test claim a
        // rewrite that never actually happened.
        for (let attempt = 0; attempt < 10; attempt++) {
          checkpointResult = await db.get('PRAGMA wal_checkpoint(TRUNCATE);');
          if (checkpointResult && Number(checkpointResult.busy) === 0) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      for (let i = 0; i < BURST_SIZE; i++) {
        seq += 1;
        await insertEvent(db, { from: 'w1', kind: 'seq', payload: JSON.stringify({ seq, tSend: Date.now() }) });
      }
      await new Promise(resolve => setTimeout(resolve, BURST_GAP_MS));
    }

    const allArrived = await pollUntil(
      () => subscribers.every(s => receivedCount(s) >= TOTAL_EVENTS),
      30000
    );

    for (const state of subscribers) state.child.send({ type: 'stop' });
    // Bounded on purpose: a stuck subscriber must fail the run, not hang
    // it; the finally below SIGKILLs any survivor. The deadline timer is
    // cleared after the race so a fast shutdown does not keep the process
    // alive for the full grace period.
    let stopDeadline = null;
    const stoppedInTime = await Promise.race([
      Promise.all(subscribers.map(s => s.stopped)).then(() => true),
      new Promise(resolve => { stopDeadline = setTimeout(() => resolve(false), 10000); })
    ]);
    if (stopDeadline) clearTimeout(stopDeadline);

    const check = (ok, label) => {
      console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}`);
      if (!ok) failures += 1;
    };

    check(allArrived, `every subscriber received all ${TOTAL_EVENTS} events within 30s of the last send`);
    check(stoppedInTime, 'every subscriber stopped and reported within 10s');
    check(checkpointResult !== null && Number(checkpointResult.busy) === 0,
      `mid-run wal_checkpoint(TRUNCATE) actually completed (${checkpointResult ? `busy=${checkpointResult.busy}` : 'never ran'})`);

    const latencies = [];
    subscribers.forEach((state, index) => {
      const events = state.deliveries.flatMap(d => d.events.map(e => ({ ...e, tRecv: d.tRecv })));
      const ids = new Set(events.map(e => e.id));
      const seqs = events.map(e => JSON.parse(e.payload).seq);
      const ordered = seqs.every((value, i) => i === 0 || value === seqs[i - 1] + 1);
      check(events.length === TOTAL_EVENTS, `subscriber ${index}: no loss (${events.length}/${TOTAL_EVENTS})`);
      check(ids.size === events.length, `subscriber ${index}: no duplicates`);
      check(ordered && seqs[0] === 1, `subscriber ${index}: per-sender order preserved`);
      check(state.fd && state.fd.final <= state.fd.baseline, `subscriber ${index}: no leaked fds (${state.fd ? `${state.fd.final} <= ${state.fd.baseline}` : 'no report'})`);
      for (const e of events) latencies.push(e.tRecv - JSON.parse(e.payload).tSend);
    });

    latencies.sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);
    const max = latencies[latencies.length - 1] ?? 0;
    check(p95 < P95_BUDGET_MS, `p95 delivery latency ${p95}ms < ${P95_BUDGET_MS}ms budget`);

    console.log('\n  report:');
    console.log(`    platform: ${distroLine()}, node ${process.version}`);
    console.log(`    events: ${TOTAL_EVENTS} x ${SUBSCRIBERS} subscribers (${latencies.length} deliveries measured)`);
    console.log(`    latency ms: p50=${p50} p95=${p95} p99=${p99} max=${max}`);
    const buckets = [[0, 10], [10, 25], [25, 50], [50, 100], [100, 250], [250, Infinity]];
    for (const [lo, hi] of buckets) {
      const n = latencies.filter(v => v >= lo && v < hi).length;
      const label = hi === Infinity ? `${lo}+` : `${lo}-${hi}`;
      console.log(`    ${label.padStart(7)}ms: ${String(n).padStart(6)} (${((n / latencies.length) * 100).toFixed(1)}%)`);
    }

    const passed = 4 + SUBSCRIBERS * 4 - failures;
    console.log(`\n${passed} passed, ${failures} failed\n`);
    process.exitCode = failures > 0 ? 1 : 0;
  } finally {
    for (const state of subscribers) {
      if (state.child.exitCode === null) state.child.kill('SIGKILL');
    }
    if (db) await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.log(`  FAIL ${err.message}`);
  console.log('\n0 passed, 1 failed\n');
  process.exit(1);
});
