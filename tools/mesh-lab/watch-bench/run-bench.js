#!/usr/bin/env node
'use strict';
// Cross-platform file-watch semantics benchmark for the mesh transport
// (issue #1253, design #1251). Measures, on the platform it runs on, the
// four things the mesh cares about when watching a SQLite store in WAL
// mode: wake latency for -wal appends, event coalescing under bursts, what
// fires (and what silently dies) across checkpoint-like atomic rename
// patterns, and the local watcher limits. Node builtins only, one file, no
// dependencies: a third party produces the missing platform's numbers by
// running exactly this script.
//
// Usage: node tools/mesh-lab/watch-bench/run-bench.js [--json <path>]

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WAKE_SAMPLES = 200;
const COALESCE_ROUNDS = 20;
const COALESCE_BURST = 50;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = v => Math.round(v * 100) / 100;
  return {
    samples: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? 0)
  };
}

// Wake latency: one directory watcher, N timed appends to state.db-wal.
// A settle pause between samples lets the previous append's trailing
// events drain so they cannot be credited to the next sample.
async function benchWakeLatency(baseDir) {
  const dir = fs.mkdtempSync(path.join(baseDir, 'wake-'));
  const target = path.join(dir, 'state.db-wal');
  fs.writeFileSync(target, 'seed');
  let pending = null;
  let lastEventAt = 0;
  const watchErrors = [];
  let watcher;
  try {
    // fs.watch throws SYNCHRONOUSLY when the platform watcher cannot be
    // created (e.g. inotify instance limits): that must degrade to a
    // reported error, not crash the run before any handler attaches.
    watcher = fs.watch(dir, (_event, filename) => {
      if (filename !== null && !String(filename).startsWith('state.db')) return;
      lastEventAt = nowMs();
      if (pending) {
        const waiter = pending;
        pending = null;
        waiter.resolve(nowMs() - waiter.t0);
      }
    });
  } catch (err) {
    return { ...stats([]), misses: WAKE_SAMPLES, watchErrors: [err.code || String(err)] };
  }
  // A watcher that dies mid-bench must also degrade to reported misses.
  watcher.on('error', err => watchErrors.push(err.code || String(err)));
  const latencies = [];
  let misses = 0;
  try {
    for (let i = 0; i < WAKE_SAMPLES; i++) {
      // Arm only after the stream has gone quiet: a trailing notification
      // from the previous append (FSEvents delivers ~50ms late) must not
      // resolve the next sample with a near-zero latency and bias the
      // distribution low.
      const quietCap = nowMs() + 500;
      while (nowMs() < quietCap && nowMs() - lastEventAt < 120) await sleep(10);
      const wake = new Promise(resolve => { pending = { t0: 0, resolve }; });
      pending.t0 = nowMs();
      fs.appendFileSync(target, 'x');
      const dt = await Promise.race([wake, sleep(1000).then(() => -1)]);
      if (dt >= 0) latencies.push(dt);
      else { misses += 1; pending = null; }
    }
  } finally {
    watcher.close();
  }
  return { ...stats(latencies), misses, watchErrors };
}

// Coalescing: how many back-to-back appends collapse into one notification.
// Each round fires a synchronous burst, then waits for the stream to go
// quiet (no event for 150ms, capped at 1s) before counting.
async function benchCoalescing(baseDir) {
  const dir = fs.mkdtempSync(path.join(baseDir, 'coalesce-'));
  const target = path.join(dir, 'state.db-wal');
  fs.writeFileSync(target, 'seed');
  const perRound = [];
  const watchErrors = [];
  for (let round = 0; round < COALESCE_ROUNDS; round++) {
    let notifications = 0;
    let lastEventAt = nowMs();
    let watcher;
    try {
      watcher = fs.watch(dir, (_event, filename) => {
        if (filename !== null && !String(filename).startsWith('state.db')) return;
        notifications += 1;
        lastEventAt = nowMs();
      });
    } catch (err) {
      watchErrors.push(err.code || String(err));
      break;
    }
    watcher.on('error', err => watchErrors.push(err.code || String(err)));
    try {
      await sleep(10);
      notifications = 0;
      for (let i = 0; i < COALESCE_BURST; i++) fs.appendFileSync(target, 'x');
      const cap = nowMs() + 1000;
      while (nowMs() < cap && nowMs() - lastEventAt < 150) await sleep(10);
      perRound.push(notifications);
    } finally {
      watcher.close();
    }
  }
  const total = perRound.reduce((a, b) => a + b, 0);
  return {
    burstSize: COALESCE_BURST,
    rounds: COALESCE_ROUNDS,
    notificationsPerBurst: {
      min: Math.min(...perRound),
      max: Math.max(...perRound),
      mean: Math.round((total / perRound.length) * 100) / 100
    },
    appendsPerNotification: total === 0
      ? null
      : Math.round((COALESCE_BURST * perRound.length / total) * 100) / 100,
    watchErrors
  };
}

// Checkpoint-like patterns: what a DIRECTORY watch and a FILE watch each
// report across atomic replace, unlink+recreate, and truncate; and whether
// the file watch is still alive afterwards (an append that goes unseen is
// the silent death the mesh must design around).
async function benchRenamePatterns(baseDir) {
  const scenarios = [];
  const runScenario = async (name, mutate) => {
    const dir = fs.mkdtempSync(path.join(baseDir, 'rename-'));
    const target = path.join(dir, 'state.db');
    fs.writeFileSync(target, 'seed');
    const dirEvents = [];
    const fileEvents = [];
    let dirWatchError = null;
    let dirWatcher = null;
    try {
      dirWatcher = fs.watch(dir, (event, filename) => dirEvents.push(`${event}:${filename}`));
      dirWatcher.on('error', err => { dirWatchError = err.code || String(err); });
    } catch (err) {
      dirWatchError = err.code || String(err);
    }
    let fileWatcher = null;
    let fileWatchError = null;
    try {
      fileWatcher = fs.watch(target, event => fileEvents.push(event));
      fileWatcher.on('error', err => { fileWatchError = err.code || String(err); });
    } catch (err) {
      fileWatchError = err.code || String(err);
    }
    try {
      await sleep(20);
      dirEvents.length = 0;
      fileEvents.length = 0;
      let mutationError = null;
      try {
        mutate(dir, target);
      } catch (err) {
        // On Windows an active watcher can hold the target open and fail
        // the rename or delete with EPERM/EBUSY. That is itself a platform
        // semantics result worth reporting, not a reason to crash the run
        // on the exact platform whose numbers the report still needs.
        mutationError = err.code || String(err);
      }
      await sleep(200);
      const eventsDuringMutation = { dir: [...dirEvents], file: [...fileEvents] };
      dirEvents.length = 0;
      fileEvents.length = 0;
      let probeError = null;
      try {
        fs.appendFileSync(target, 'probe');
      } catch (err) {
        probeError = err.code || String(err);
      }
      await sleep(200);
      scenarios.push({
        scenario: name,
        mutationError,
        eventsDuringMutation,
        probeAppendAfter: {
          dirWatchSaw: dirEvents.length > 0,
          fileWatchSaw: fileEvents.length > 0,
          fileWatchError,
          dirWatchError,
          probeError
        }
      });
    } finally {
      if (dirWatcher) dirWatcher.close();
      if (fileWatcher) fileWatcher.close();
    }
  };

  await runScenario('atomic-replace (write tmp, rename over target)', (dir, target) => {
    const tmp = path.join(dir, 'state.db.tmp');
    fs.writeFileSync(tmp, 'replacement');
    fs.renameSync(tmp, target);
  });
  await runScenario('unlink + recreate', (dir, target) => {
    fs.rmSync(target);
    fs.writeFileSync(target, 'recreated');
  });
  await runScenario('truncate in place', (dir, target) => {
    fs.truncateSync(target, 0);
  });
  return scenarios;
}

function readLimits() {
  if (process.platform === 'linux') {
    const read = name => {
      try {
        return fs.readFileSync(`/proc/sys/fs/inotify/${name}`, 'utf8').trim();
      } catch {
        return 'unreadable';
      }
    };
    return {
      backend: 'inotify',
      max_user_watches: read('max_user_watches'),
      max_user_instances: read('max_user_instances'),
      max_queued_events: read('max_queued_events')
    };
  }
  if (process.platform === 'darwin') {
    const sysctl = name => {
      try {
        return execFileSync('sysctl', ['-n', name], { encoding: 'utf8' }).trim();
      } catch {
        return 'unreadable';
      }
    };
    return {
      backend: 'FSEvents (per-watcher kqueue for file watches)',
      kern_maxfiles: sysctl('kern.maxfiles'),
      kern_maxfilesperproc: sysctl('kern.maxfilesperproc')
    };
  }
  return { backend: process.platform === 'win32' ? 'ReadDirectoryChangesW' : 'unknown' };
}

async function main() {
  const jsonFlag = process.argv.indexOf('--json');
  const jsonPath = jsonFlag > -1 ? process.argv[jsonFlag + 1] : null;
  if (jsonFlag > -1 && !jsonPath) {
    console.error('usage: node run-bench.js [--json <path>]');
    process.exit(2);
  }
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-watch-bench-'));
  try {
    console.log(`watch-bench: ${process.platform} ${os.release()} ${os.arch()}, node ${process.version}`);
    console.log('measuring wake latency...');
    const wakeLatencyMs = await benchWakeLatency(baseDir);
    console.log('measuring coalescing...');
    const coalescing = await benchCoalescing(baseDir);
    console.log('probing rename/checkpoint patterns...');
    const renamePatterns = await benchRenamePatterns(baseDir);
    const result = {
      env: {
        platform: process.platform,
        release: os.release(),
        arch: os.arch(),
        node: process.version,
        date: new Date().toISOString()
      },
      wakeLatencyMs,
      coalescing,
      renamePatterns,
      limits: readLimits()
    };
    const rendered = JSON.stringify(result, null, 2);
    console.log(rendered);
    if (jsonPath) {
      fs.writeFileSync(jsonPath, rendered);
      console.log(`written: ${jsonPath}`);
    }
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('[FAIL]', err);
  process.exit(1);
});
