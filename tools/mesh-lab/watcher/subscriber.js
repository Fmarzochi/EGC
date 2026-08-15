'use strict';
// One subscriber process. Watches the store, drains new events with its own
// in-memory id cursor (drain until empty, then park on the watcher), stamps
// arrival time per drained batch, and streams batches to the harness over
// IPC. On {type:'stop'} it tears everything down and reports its open-fd
// count, measured AFTER closing watcher and db, so the harness can assert
// nothing leaked against the baseline measured before they were opened.
//
// argv: [2] = db path, [3] = 'top' (cursor starts at MAX(id)) or a number.

const fs = require('node:fs');
const { loadSqliteDriver } = require('./lib/deps');
const { openStore, maxEventId, readSince } = require('./lib/store');
const { createWalWatcher } = require('./lib/wal-watcher');

function countOpenFds() {
  return fs.readdirSync('/proc/self/fd').length;
}

async function main() {
  if (typeof process.send !== 'function') {
    console.error('subscriber.js must be forked with an IPC channel');
    process.exit(2);
  }
  const dbPath = process.argv[2];
  const startFrom = process.argv[3] || 'top';

  const driver = loadSqliteDriver();
  if (!driver) {
    process.send({ type: 'fatal', error: 'sqlite driver unavailable' });
    process.exit(3);
  }

  // Warm-up before the baseline: the first fs.watch makes libuv open one
  // shared inotify instance that outlives every watcher, so the baseline
  // must be taken with that instance already alive for "final <= baseline"
  // to measure OUR teardown and not the runtime's loop-lifetime fd.
  const warmup = createWalWatcher(dbPath);
  warmup.close();
  const fdBaseline = countOpenFds();
  const db = await openStore(driver, dbPath);
  const watcher = createWalWatcher(dbPath);
  let cursor = startFrom === 'top' ? await maxEventId(db) : Number(startFrom);

  let stopping = false;
  process.on('message', msg => {
    if (msg && msg.type === 'stop') {
      stopping = true;
      watcher.close();
    }
  });

  process.send({ type: 'ready', pid: process.pid, fdBaseline, mode: watcher.mode, cursor });

  while (!stopping) {
    const events = await readSince(db, cursor);
    if (events.length > 0) {
      const tRecv = Date.now();
      cursor = Number(events[events.length - 1].id);
      process.send({
        type: 'delivery',
        tRecv,
        events: events.map(e => ({ id: Number(e.id), from: e.from_session, payload: e.payload }))
      });
      continue;
    }
    await watcher.waitForChange(500);
  }

  await db.close();
  // The driver and watcher hand their descriptors back through the event
  // loop, not synchronously at close(): poll with a deadline instead of
  // reading once and racing the release. Generous on purpose: a contended
  // CI runner can delay libuv's handle sweep well past the common case.
  const deadline = Date.now() + 5000;
  let fdFinal = countOpenFds();
  while (fdFinal > fdBaseline && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
    fdFinal = countOpenFds();
  }
  // No process.exit here: a hard exit can discard the async IPC write. The
  // send callback disconnects the channel, the loop drains, and the process
  // leaves on its own with the report guaranteed delivered.
  process.send({ type: 'stopped', fdBaseline, fdFinal }, () => process.disconnect());
  process.exitCode = 0;
}

main().catch(err => {
  if (typeof process.send === 'function') {
    process.send({ type: 'fatal', error: String(err && err.stack ? err.stack : err) });
  }
  console.error('[subscriber FAIL]', err);
  process.exit(1);
});
