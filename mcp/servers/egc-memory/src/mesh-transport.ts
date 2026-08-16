// Mesh transport v0 (design issue #1251, layer C2): wake-on-write delivery
// over the session-bus store. An fs.watch on the store's directory is only a
// wake signal: correctness always comes from re-reading the bus tables under
// the same cursor semantics as session_events, so a missed, coalesced, or
// spurious filesystem event can delay one delivery round (bounded by the
// caller's repoll ceiling) but can never lose or duplicate an event.
//
// SQLite in WAL mode appends to `<db>-wal` and periodically checkpoints back
// into the main file, sometimes replacing files wholesale. Watching the
// directory instead of a single file survives both patterns; the basename
// filter keeps unrelated writes in the same directory from waking waiters.
// Push is ON by default since 2026-08-16 (the README's promise is real-time
// context with no manual steps); EGC_MESH_PUSH=0 opts a server out, restoring
// the pre-mesh behavior where session_wait degrades to a single read.

import fs from 'node:fs';
import path from 'node:path';

export const MESH_PUSH_FLAG = 'EGC_MESH_PUSH';
export const DEFAULT_DEBOUNCE_MS = 25;
// Ceiling for a single waitForChange round: callers loop with
// `min(remaining, ceiling)` so a lost filesystem event degrades to a slow
// poll instead of a hang until the caller's full timeout.
export const DEFAULT_REPOLL_CEILING_MS = 2000;
// Hard cap for one session_wait call, kept well under MCP client timeouts.
export const MAX_SESSION_WAIT_MS = 25000;

export type WakeReason = 'change' | 'timeout' | 'closed';

export interface MeshTransportOptions {
  dbPath: string;
  debounceMs?: number;
  // Test seam; also exercised as the fallback path for platforms where
  // fs.watch is unavailable or throws at creation time.
  watchImpl?: typeof fs.watch;
}

export interface MeshTransport {
  readonly mode: 'watch' | 'interval';
  pendingWaiters(): number;
  waitForChange(timeoutMs: number): Promise<WakeReason>;
  close(): void;
}

export function meshPushEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[MESH_PUSH_FLAG] !== '0';
}

export interface BusWaitParams {
  transport: MeshTransport;
  // First read of the wait: may refresh presence (announce/sweep writes).
  readFresh: () => Promise<Record<string, unknown>[]>;
  // Every re-read after a wake. MUST NOT write to the store while the queue
  // is empty: the loop's own writes would land in the WAL, retrigger the
  // watcher, and turn the parked long-poll into a self-waking storm that
  // burns CPU and grows the WAL until the timeout. (A cursor advance when
  // events DO arrive is fine: the loop exits on delivery.)
  readQuiet: () => Promise<Record<string, unknown>[]>;
  timeoutMs: number;
  repollCeilingMs?: number;
}

export interface BusWaitResult {
  events: Record<string, unknown>[];
  waitedMs: number;
  rounds: number;
}

export async function waitForBusEvents(params: BusWaitParams): Promise<BusWaitResult> {
  const startedAt = Date.now();
  const deadline = startedAt + params.timeoutMs;
  const ceiling = params.repollCeilingMs ?? DEFAULT_REPOLL_CEILING_MS;
  let rounds = 0;
  let events = await params.readFresh();
  while (events.length === 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const reason = await params.transport.waitForChange(Math.min(remaining, ceiling));
    if (reason === 'closed') break;
    rounds += 1;
    events = await params.readQuiet();
  }
  return { events, waitedMs: Date.now() - startedAt, rounds };
}

export function createMeshTransport(options: MeshTransportOptions): MeshTransport {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const dir = path.dirname(options.dbPath);
  const base = path.basename(options.dbPath);
  const waiters = new Set<(reason: WakeReason) => void>();
  let debounceTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const wakeAll = (reason: WakeReason): void => {
    const pending = [...waiters];
    waiters.clear();
    for (const resolve of pending) resolve(reason);
  };

  const scheduleWake = (): void => {
    if (closed || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      wakeAll('change');
    }, debounceMs);
    debounceTimer.unref();
  };

  let watcher: fs.FSWatcher | null = null;
  let mode: 'watch' | 'interval' = 'watch';
  try {
    const watchImpl = options.watchImpl ?? fs.watch;
    // persistent:false so a live transport never keeps the process alive.
    watcher = watchImpl(dir, { persistent: false }, (_event, filename) => {
      // A null filename (delivered by some platforms under load) must wake:
      // waking on too little risks a stall until the repoll ceiling, waking
      // on too much only costs one SQL re-read. The name match is tight on
      // purpose: the db itself and its `-wal`/`-shm`/`-journal` sidecars
      // wake waiters, while cousins like `state.db.backup` do not, so
      // unrelated snapshots in the directory cannot churn parked readers.
      const name = filename === null ? null : String(filename);
      if (name === null || name === base || name.startsWith(`${base}-`)) scheduleWake();
    });
    watcher.on('error', () => {
      // A watcher that dies at runtime (e.g. watch descriptor limits) must
      // not take delivery down with it: waiters keep resolving through their
      // own timers, which is precisely the interval mode contract.
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
    pendingWaiters(): number {
      return waiters.size;
    },
    waitForChange(timeoutMs: number): Promise<WakeReason> {
      if (closed) return Promise.resolve('closed');
      return new Promise<WakeReason>(resolve => {
        const waiter = (reason: WakeReason): void => {
          clearTimeout(timer);
          resolve(reason);
        };
        // Deliberately NOT unref'd: a pending waiter is a promise owed to a
        // caller, and the process must not exit out from under it. close()
        // clears these timers, so shutdown is never delayed by a parked wait.
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve('timeout');
        }, Math.max(1, timeoutMs));
        waiters.add(waiter);
      });
    },
    close(): void {
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
