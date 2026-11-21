import type { Database } from 'sqlite';

import { log } from './memory-logging';
import { writeArbitrator } from './memory-db';
import { sendEvent } from './session-bus';
import type { SyncConfig } from './sync/SyncBackend';
import { getTeamConfig, teamSync } from './sync/TeamSync';

// Wrote, told: whenever a tool writes memory (update_state, store_decision,
// lesson_save, working_memory_set), the server itself tells the sessions of
// this machine through the bus and the bridge forwards the notice to the
// other machines that have the repository open. After a write of state a
// sync with the team remote is scheduled too, so the tools without a hook
// push and the sync no longer depends on the start and the end of a session
// alone; the other kinds stay on the machine until they travel as well.
// Several writes close together become one sync; a notice of state from
// another machine pulls sooner.
export const MEMORY_CHANGED_KIND = 'memory:changed';
export const PUSH_DELAY_MS = 30_000;
export const PULL_DELAY_MS = 2_000;
// The notices of one server kept on the bus for one project (or for the
// global memory): an older one says nothing a newer one does not, and the
// bus caps what one sender may hold.
const NOTICES_KEPT = 20;

export type MemoryChangeKind = 'state' | 'decision' | 'lesson' | 'working-memory';

export interface MemoryChange {
  kind: MemoryChangeKind;
  projectPath: string | null;
  branch?: string | null;
  scope?: 'project' | 'global';
}

export interface MemoryChangeNotice extends MemoryChange {
  at: string;
  hint: string;
}

const HINT = 'the memory changed on another session or machine: read get_state again before relying on what you hold';

interface SyncOptions {
  sync: () => Promise<unknown>;
  enabled: () => boolean;
  pushDelayMs: number;
  pullDelayMs: number;
}

// The delays can be shortened through the environment, which is how a test
// that drives the built server proves them without waiting half a minute.
function delayFromEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// The sync after a write follows the switch of the sync around the session
// (`egc team autosync`): off, a write is told and nothing syncs by itself.
function autosyncOn(): boolean {
  const config = getTeamConfig() as (SyncConfig & { autosync?: boolean }) | null;
  return config?.autosync === true;
}

const defaults: SyncOptions = {
  sync: () => teamSync(),
  enabled: autosyncOn,
  pushDelayMs: delayFromEnv('EGC_MEMORY_PUSH_DELAY_MS', PUSH_DELAY_MS),
  pullDelayMs: delayFromEnv('EGC_MEMORY_PULL_DELAY_MS', PULL_DELAY_MS),
};
let options: SyncOptions = { ...defaults };
let timer: NodeJS.Timeout | null = null;
let dueAt = 0;
let activeRun: Promise<void> | null = null;
let again = false;

// The tests hand in the sync and shorter delays; a server runs the defaults.
export function configureMemorySync(overrides: Partial<SyncOptions> = {}): void {
  cancelScheduledSync();
  options = { ...defaults, ...overrides };
}

export function parseMemoryChange(payload: unknown): MemoryChangeNotice | null {
  if (typeof payload !== 'string' || !payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<MemoryChangeNotice>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.kind !== 'string') return null;
    return parsed as MemoryChangeNotice;
  } catch {
    return null;
  }
}

// Tells the bus that memory changed: a broadcast inside the project (or to
// every session, for the global memory), from the session of this server.
// Then, for a change of state, the sync is scheduled. Nothing here can fail
// a memory call.
export async function notifyMemoryChanged(db: Database, sessionId: string, change: MemoryChange): Promise<void> {
  const notice: MemoryChangeNotice = { ...change, at: new Date().toISOString(), hint: HINT };
  const projectPath = change.projectPath ?? null;
  try {
    await writeArbitrator.enqueue(async () => {
      // The cap holds per project, so the notices of one project never push
      // out the unread notices of another.
      await db.run(
        `DELETE FROM bus_events WHERE from_session = ? AND kind = ? AND project_path IS ? AND id NOT IN (
           SELECT id FROM bus_events WHERE from_session = ? AND kind = ? AND project_path IS ? ORDER BY id DESC LIMIT ?)`,
        [sessionId, MEMORY_CHANGED_KIND, projectPath, sessionId, MEMORY_CHANGED_KIND, projectPath, NOTICES_KEPT - 1]
      );
      const sent = await sendEvent(db, { fromSession: sessionId, projectPath: projectPath ?? undefined, kind: MEMORY_CHANGED_KIND, payload: JSON.stringify(notice) });
      if (!sent.ok) log('WARN', 'memory change notice not sent', { reason: sent.reason });
    });
  } catch (error) {
    log('WARN', 'memory change notice not sent', { error: String(error) });
  }
  // Only the state trees travel with the team sync today; a lesson, a
  // decision or a working memory entry is told, and syncs once it travels.
  if (change.kind === 'state') scheduleMemorySync(options.pushDelayMs);
}

// A sync with the team remote within `delayMs`, when the machine has one:
// a request that is due sooner than the one pending moves it forward, a
// later one joins it, and a request that lands while a sync runs makes it
// run once more afterwards.
export function scheduleMemorySync(delayMs: number = options.pushDelayMs): void {
  if (!options.enabled()) return;
  const due = Date.now() + Math.max(0, delayMs);
  if (timer && due >= dueAt) return;
  if (timer) clearTimeout(timer);
  dueAt = due;
  timer = setTimeout(() => {
    timer = null;
    runSync().catch(() => undefined);
  }, Math.max(0, delayMs));
  timer.unref();
}

// What another machine said about its memory: pull sooner than a write of
// our own would push.
export function scheduleMemoryPull(): void {
  scheduleMemorySync(options.pullDelayMs);
}

export function cancelScheduledSync(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  dueAt = 0;
}

// The pending sync run now, before the server closes, so a write of the
// last minute does not wait for the next session.
export async function flushScheduledSync(): Promise<void> {
  // A sync already running is waited for; one still scheduled runs now; a
  // repetition one of them asked for is taken by the call that follows.
  const pending = timer !== null;
  cancelScheduledSync();
  if (activeRun !== null) await activeRun;
  else if (pending) await runSync();
  if (timer !== null || activeRun !== null) await flushScheduledSync();
}

function reportSync(result: unknown): void {
  const errors = (result as { errors?: unknown } | null)?.errors;
  if (Array.isArray(errors) && errors.length > 0) log('WARN', 'memory sync after a write reported errors', { errors });
}

async function runSync(): Promise<void> {
  if (activeRun !== null) {
    again = true;
    return;
  }
  activeRun = (async () => {
    try {
      reportSync(await options.sync());
    } catch (error) {
      log('WARN', 'memory sync after a write failed', { error: error instanceof Error ? error.message : String(error) });
    }
  })().finally(() => {
    activeRun = null;
    if (again) {
      again = false;
      scheduleMemorySync(0);
    }
  });
  await activeRun;
}
