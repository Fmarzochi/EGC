'use strict';
// Wake-on-write watcher over a SQLite store living in WAL mode. inotify via
// fs.watch on the store's DIRECTORY, never on a single file: appends land in
// `<db>-wal`, checkpoints rewrite `<db>` (sometimes through atomic renames),
// and a directory watch survives both where a file watch silently dies with
// the replaced inode. The watcher is strictly a wake signal: subscribers
// re-read the bus table by id cursor after every wake, so a coalesced or
// dropped notification can only delay a delivery round (bounded by the
// caller's repoll ceiling), never lose or duplicate an event.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DEBOUNCE_MS = 10;

function createWalWatcher(dbPath, options = {}) {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const waiters = new Set();
  let debounceTimer = null;
  let closed = false;

  const wakeAll = reason => {
    const pending = [...waiters];
    waiters.clear();
    for (const resolve of pending) resolve(reason);
  };

  const scheduleWake = () => {
    if (closed || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      wakeAll('change');
    }, debounceMs);
    debounceTimer.unref();
  };

  let watcher = null;
  let mode = 'watch';
  try {
    // persistent:false: a parked watcher must never keep a process alive.
    watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      // A null filename must wake: waking on too little stalls delivery,
      // waking on too much only costs one indexed SQL re-read.
      if (filename === null || String(filename).startsWith(base)) scheduleWake();
    });
    watcher.on('error', () => {
      watcher = null;
      mode = 'interval';
    });
  } catch {
    watcher = null;
    mode = 'interval';
  }

  return {
    get mode() {
      return mode;
    },
    pendingWaiters() {
      return waiters.size;
    },
    waitForChange(timeoutMs) {
      if (closed) return Promise.resolve('closed');
      return new Promise(resolve => {
        const waiter = reason => {
          clearTimeout(timer);
          resolve(reason);
        };
        // Deliberately referenced (not unref'd): a pending waiter is a
        // promise owed to a caller and must keep the process alive until it
        // resolves. close() clears the timer, so teardown is never delayed.
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve('timeout');
        }, Math.max(1, timeoutMs));
        waiters.add(waiter);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      wakeAll('closed');
    }
  };
}

module.exports = { createWalWatcher, DEFAULT_DEBOUNCE_MS };
