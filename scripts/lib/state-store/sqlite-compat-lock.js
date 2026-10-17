'use strict';

// The cross-process lock protocol of the state store: one lock file next to
// the database, taken with an exclusive create and released by its owner,
// with the Windows retries, the in-process mutex per file and the read of a
// file together with the identity of its bytes. Shared by the portable
// engine (sqlite-compat-wasm.js) and the CLI adapter (db-adapter.js).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

class InProcessMutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    await new Promise(resolve => this._queue.push(resolve));
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }
}

const fileMutexes = new Map();
function getFileMutex(filepath) {
  let m = fileMutexes.get(filepath);
  if (!m) {
    m = new InProcessMutex();
    fileMutexes.set(filepath, m);
  }
  return m;
}

// Process-level map tracking lock paths and tokens currently held by this process.
const heldLocks = new Map();
let signalHandlersRegistered = false;

function unlinkLockIfOwned(lockPath, token) {
  if (!token || typeof token !== 'string') return false;
  try {
    if (!fs.existsSync(lockPath)) return true;
    const raw = fs.readFileSync(lockPath, 'utf8');
    const data = JSON.parse(raw);
    if (data?.token === token) {
      retryWhileWindowsBusy(() => fs.unlinkSync(lockPath));
      return true;
    }
    // Lock file exists but belongs to a different token/owner
    return true;
  } catch (err) {
    return err?.code === 'ENOENT';
  }
}

function cleanupHeldLocks() {
  for (const [lockPath, token] of heldLocks.entries()) {
    unlinkLockIfOwned(lockPath, token);
  }
  heldLocks.clear();
}

function registerSignalHandlersOnce() {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;

  // Process exit is the definitive lifecycle hook where process-held locks must be cleaned up.
  process.once('exit', () => {
    cleanupHeldLocks();
  });

  const handleSignal = (signal) => {
    // If another application listener is registered, it controls the process lifecycle
    // (e.g. graceful shutdown, drain, or ignoring the signal).
    // Releasing locks here while the process might continue writing would cause concurrency hazards.
    // Furthermore, we do NOT re-raise the signal if other listeners exist, because doing so would
    // invoke those application listeners a second time. We leave our listener registered so that
    // subsequent signals are handled safely.
    // If no other listener exists, default signal termination should occur:
    // clean up our owned locks, remove our listener, and re-raise the signal.
    if (process.listenerCount(signal) > 1) {
      return;
    }
    cleanupHeldLocks();
    process.removeListener(signal, signalHandlers[signal]);
    process.kill(process.pid, signal);
  };

  const signalHandlers = {
    SIGINT: () => handleSignal('SIGINT'),
    SIGTERM: () => handleSignal('SIGTERM'),
  };

  process.on('SIGINT', signalHandlers.SIGINT);
  process.on('SIGTERM', signalHandlers.SIGTERM);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

function checkSameInodeOrEmpty(fd, lockPath) {
  try {
    const fstat = fs.fstatSync(fd);
    const stat = fs.statSync(lockPath);
    return (fstat.ino && stat.ino) ? fstat.ino === stat.ino : stat.size === 0;
  } catch (statErr) {
    if (statErr.code !== 'ENOENT') {
      process.stderr.write(`[sqlite-compat] stat verification failed for ${lockPath}: ${statErr.message}\n`);
    }
    return false;
  }
}

function cleanupFailedLockWrite(fd, lockPath) {
  let isOurFile;
  try {
    isOurFile = checkSameInodeOrEmpty(fd, lockPath);
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ignore close error */ }
  }
  if (isOurFile) {
    try { fs.unlinkSync(lockPath); } catch (_) { /* ignore unlink error */ }
  }
}

// Windows answers EPERM, EACCES or EBUSY for a file another process still
// has open or is still deleting: an exclusive open on a lock file in that
// state, a rename over the database while a reader holds it, the unlink of
// the lock while a poller reads it. Those are moments, not refusals, so on
// Windows alone the operation is repeated for a short while before the
// error surfaces; elsewhere the same codes mean the directory refuses the
// write and the error surfaces at once.
const WINDOWS_BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const WINDOWS_BUSY_RETRY_MS = 2000;

function isWindowsBusyError(err) {
  return process.platform === 'win32' && WINDOWS_BUSY_CODES.has(err?.code);
}

function isLockBusyError(err) {
  return err?.code === 'EEXIST' || isWindowsBusyError(err);
}

function retryWhileWindowsBusy(operation) {
  const deadline = Date.now() + WINDOWS_BUSY_RETRY_MS;
  for (;;) {
    try {
      return operation();
    } catch (err) {
      if (!isWindowsBusyError(err) || Date.now() >= deadline) throw err;
      sleepSync(5 + crypto.randomInt(0, 10));
    }
  }
}

// A rename over an existing file, repeated while Windows reports the target busy.
function renameOverSync(from, to) {
  retryWhileWindowsBusy(() => fs.renameSync(from, to));
}

// The bytes of the file and the identity of those very bytes, taken from
// one handle. A stat of the path after the read can already describe the
// file another process renamed over it in between; a copy loaded that way
// would pass the change check as current and overwrite that process's rows
// on its next persist (seen on Windows, where the window is wide enough).
// A missing file has no bytes and no identity.
function readFileWithIdentity(filename) {
  let fd;
  try {
    fd = retryWhileWindowsBusy(() => fs.openSync(filename, 'r'));
  } catch (err) {
    if (err?.code === 'ENOENT') return { data: null, mtimeMs: 0, ino: 0 };
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    return { data: fs.readFileSync(fd), mtimeMs: stat.mtimeMs, ino: stat.ino };
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ignore close error */ }
  }
}

function tryAcquireLockOnce(lockPath, token) {
  let fd;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (isLockBusyError(err)) return false;
    throw err;
  }
  try {
    const payload = JSON.stringify({
      token,
      pid: process.pid,
      acquiredAt: Date.now(),
      hostname: os.hostname(),
    });
    fs.writeFileSync(fd, payload);
    return true;
  } catch (writeErr) {
    cleanupFailedLockWrite(fd, lockPath);
    fd = undefined;
    throw writeErr;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* ignore close error */ }
    }
  }
}

function releaseFileLock(lockPath, token) {
  if (!token || typeof token !== 'string') return;
  const unlinked = unlinkLockIfOwned(lockPath, token);
  if (unlinked) {
    heldLocks.delete(lockPath);
  }
}

function checkDeadProcessHolder(holder, lockPath) {
  if (!holder) return;
  const sameHost = holder.hostname === os.hostname();
  const isValidPid = Number.isInteger(holder.pid) && holder.pid > 0;
  const isDeadLocalPid = sameHost && isValidPid && !isProcessAlive(holder.pid);
  if (isDeadLocalPid) {
    const currentHolder = readLockHolder(lockPath);
    if (currentHolder && currentHolder.token === holder.token && currentHolder.pid === holder.pid) {
      throw new Error(
        `[sqlite-compat] Lock file "${lockPath}" is held by dead process PID ${holder.pid} on host ${holder.hostname}. ` +
        `Automatic stale-lock recovery is disabled to ensure strict mutual exclusion. ` +
        `To recover manually, verify that process ${holder.pid} is not running, then remove the lock file: rm "${lockPath}"`
      );
    }
  }
}

function readLockHolder(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    if (raw.trim()) {
      return JSON.parse(raw);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Malformed JSON or transient read error: fail closed by returning null to keep waiting
    }
  }
  return null;
}

function delayWithJitter(retryIntervalMs) {
  const jitter = crypto.randomInt(0, 20);
  return new Promise(r => setTimeout(r, retryIntervalMs + jitter));
}

// One attempt per call, then a jittered pause and the next attempt, until
// the lock is taken or the deadline passes; the last holder seen is carried
// along for the timeout message.
async function pollLockUntilAcquired(lockPath, token, deadline, retryIntervalMs, lastHolder = null) {
  if (Date.now() >= deadline) return { token: null, lastHolder };
  if (tryAcquireLockOnce(lockPath, token)) {
    heldLocks.set(lockPath, token);
    return { token, lastHolder: null };
  }
  const holder = readLockHolder(lockPath);
  if (holder) checkDeadProcessHolder(holder, lockPath);
  await delayWithJitter(retryIntervalMs);
  return pollLockUntilAcquired(lockPath, token, deadline, retryIntervalMs, holder || lastHolder);
}

function lockTimeoutError(lockPath, timeoutMs, lastHolder) {
  const hostInfo = (lastHolder?.hostname && lastHolder.hostname !== os.hostname()) ? ` on host ${lastHolder.hostname}` : '';
  const holderInfo = lastHolder ? ` (held by PID ${lastHolder.pid}${hostInfo}, token ${lastHolder.token})` : '';
  return new Error(`[sqlite-compat] Lock timeout after ${timeoutMs}ms acquiring ${lockPath}${holderInfo}`);
}

async function acquireFileLock(lockPath, { timeoutMs = 15000, retryIntervalMs = 25 } = {}) {
  registerSignalHandlersOnce();
  const token = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  const result = await pollLockUntilAcquired(lockPath, token, deadline, retryIntervalMs);
  if (result.token) {
    return result.token;
  }
  throw lockTimeoutError(lockPath, timeoutMs, result.lastHolder);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

// The synchronous twin of acquireFileLock, for the CLI adapter whose
// callers are synchronous: the same lock file, the same owner token and the
// same fail-closed check of a dead holder, with the wait done in place.
function acquireFileLockSync(lockPath, { timeoutMs = 15000, retryIntervalMs = 25 } = {}) {
  registerSignalHandlersOnce();
  const token = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  let lastHolder = null;
  while (Date.now() < deadline) {
    if (tryAcquireLockOnce(lockPath, token)) {
      heldLocks.set(lockPath, token);
      return token;
    }
    const holder = readLockHolder(lockPath);
    if (holder) {
      lastHolder = holder;
      checkDeadProcessHolder(holder, lockPath);
    }
    sleepSync(retryIntervalMs + crypto.randomInt(0, 20));
  }
  throw lockTimeoutError(lockPath, timeoutMs, lastHolder);
}

module.exports = { getFileMutex, isProcessAlive, retryWhileWindowsBusy, renameOverSync, readFileWithIdentity, acquireFileLock, acquireFileLockSync, releaseFileLock };
