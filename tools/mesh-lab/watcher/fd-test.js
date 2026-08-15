'use strict';
// Teardown test (#1252): repeated create/park/close cycles must return the
// process to its file-descriptor baseline, asserted via /proc/self/fd. The
// watcher's inotify descriptor is the resource a naive implementation leaks
// first; a close() that strands a parked waiter is the second failure mode,
// so one cycle in two parks a waiter before closing.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWalWatcher } = require('./lib/wal-watcher');

const CYCLES = 40;

function countOpenFds() {
  return fs.readdirSync('/proc/self/fd').length;
}

async function pollUntil(predicate, deadlineMs, stepMs = 20) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
  return predicate();
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-mesh-fd-'));
  const dbPath = path.join(dir, 'state.db');
  try {
    console.log(`\n--- fd teardown test: ${CYCLES} create/park/close cycles ---`);
    // Warm-up before the baseline: libuv opens ONE shared inotify instance
    // per event loop on the first fs.watch and keeps it for the loop's
    // lifetime even after every watcher is closed. The per-watcher resource
    // is the watch descriptor, which close() does release, so the honest
    // leak criterion is zero fd growth ACROSS cycles, not a return to the
    // pre-inotify count.
    const warmup = createWalWatcher(dbPath);
    warmup.close();
    const baseline = countOpenFds();
    for (let i = 0; i < CYCLES; i++) {
      const watcher = createWalWatcher(dbPath);
      if (i % 2 === 0) {
        const parked = watcher.waitForChange(5000);
        watcher.close();
        const reason = await parked;
        if (reason !== 'closed') throw new Error(`cycle ${i}: parked waiter resolved '${reason}', expected 'closed'`);
      } else {
        await watcher.waitForChange(5);
        watcher.close();
      }
      if (watcher.pendingWaiters() !== 0) throw new Error(`cycle ${i}: waiters left behind`);
    }
    const settled = await pollUntil(() => countOpenFds() <= baseline, 3000);
    const final = countOpenFds();
    if (!settled) throw new Error(`fd count ${final} never returned to baseline ${baseline}`);
    console.log(`  PASS fd baseline held (${baseline} before, ${final} after ${CYCLES} cycles)`);
    console.log('\n1 passed, 0 failed\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.log(`  FAIL ${err.message}`);
  console.log('\n0 passed, 1 failed\n');
  process.exit(1);
});
