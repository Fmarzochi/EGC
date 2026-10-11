// Per-tool, per-project call counter behind every tool of the server:
// a key is `<project>::<tool>` when the call names a project, `<tool>`
// otherwise, and a call is allowed while the key holds at most maxCalls
// timestamps inside the window.
export interface RateLimiter {
  check(tool: string, projectPath?: string | null, now?: number): boolean;
  size(): number;
}

interface Entry {
  stamps: number[];
  // The newest call ever recorded for the key, kept apart from the array
  // because a clock that steps backwards can push an older stamp last.
  newest: number;
}

export function createRateLimiter({ windowMs, maxCalls }: { windowMs: number; maxCalls: number }): RateLimiter {
  const calls = new Map<string, Entry>();
  let lastSweep = Number.NEGATIVE_INFINITY;

  // Runs at most once per window, so a check costs one map lookup and
  // the sweep is spread over the calls of the window: a key whose newest
  // call already left the window holds nothing the next check can use,
  // so it goes, and the map stays bounded by the keys active in the
  // last two windows instead of growing for the life of the process
  // (#1682). A clock that stepped backwards sweeps at once instead of
  // waiting to catch up with the last sweep; `newest` keeps the live
  // keys safe.
  function sweep(now: number): void {
    if (now >= lastSweep && now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, entry] of calls) {
      if (now - entry.newest >= windowMs) calls.delete(key);
    }
  }

  function check(tool: string, projectPath?: string | null, now: number = Date.now()): boolean {
    sweep(now);
    const trimmed = projectPath ? projectPath.trim() : '';
    const key = trimmed !== '' ? `${trimmed}::${tool}` : tool;
    const entry = calls.get(key);
    const stamps = (entry?.stamps ?? []).filter(t => now - t < windowMs);
    stamps.push(now);
    calls.set(key, { stamps, newest: Math.max(entry?.newest ?? now, now) });
    return stamps.length <= maxCalls;
  }

  return { check, size: () => calls.size };
}
