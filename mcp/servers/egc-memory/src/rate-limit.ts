// A per-tool, per-project limit on the calls this server answers (#2142): an
// honest session never reaches it, a looping agent or a runaway script gets a
// clear refusal instead of hammering the state store or the session bus. One
// sliding window per key; the keys of callers that went quiet are dropped once
// per window, so the map never outgrows the callers of the last two windows.

import path from 'node:path';

export interface RateLimitSettings {
  windowMs: number;
  maxCalls: number;
}

export interface RateLimiter {
  check(tool: string, projectPath?: string | null, now?: number): boolean;
  size(): number;
}

interface Bucket {
  stamps: number[];
  // The newest call the key ever saw, kept apart from the array: a clock that
  // steps backwards pushes an older stamp last, and the sweep must not take
  // that tail for the key's most recent call.
  newest: number;
}

const ENV_NAMES: Array<[keyof RateLimitSettings, string]> = [
  ['maxCalls', 'EGC_MCP_RATE_MAX_CALLS'],
  ['windowMs', 'EGC_MCP_RATE_WINDOW_MS'],
];

// The same two variables the Guardian reads. A value that is not a whole
// positive number keeps the default rather than turning the limit off.
export function rateLimitSettings(env: NodeJS.ProcessEnv, defaults: RateLimitSettings): RateLimitSettings {
  const settings = { ...defaults };
  for (const [field, name] of ENV_NAMES) {
    const raw = env[name];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) settings[field] = value;
  }
  return settings;
}

// One bucket per project however the path is spelt (/repo, /repo/, ../repo).
function bucketKey(tool: string, projectPath?: string | null): string {
  const trimmed = (projectPath ?? '').trim();
  return `${trimmed ? path.resolve(trimmed) : ''}::${tool}`;
}

export function createRateLimiter(settings: RateLimitSettings): RateLimiter {
  const buckets = new Map<string, Bucket>();
  let sweptAt = Number.NEGATIVE_INFINITY;

  // At most once per window, not on every call: a burst spread over many
  // project paths would otherwise walk the whole map for each call. A clock
  // that stepped backwards sweeps at once instead of waiting to catch up with
  // the last sweep, and `newest` keeps a key with a recent call alive.
  function dropIdle(now: number): void {
    if (now >= sweptAt && now - sweptAt < settings.windowMs) return;
    sweptAt = now;
    for (const [key, bucket] of buckets) {
      if (now - bucket.newest >= settings.windowMs) buckets.delete(key);
    }
  }

  function check(tool: string, projectPath?: string | null, now: number = Date.now()): boolean {
    dropIdle(now);
    const key = bucketKey(tool, projectPath);
    const bucket = buckets.get(key);
    const live = (bucket?.stamps ?? []).filter(stamp => now - stamp < settings.windowMs);
    live.push(now);
    const allowed = live.length <= settings.maxCalls;
    // Only the newest maxCalls stamps are kept: a caller that keeps hammering
    // costs the same as one at the limit, and the verdict is the same.
    buckets.set(key, { stamps: live.slice(-settings.maxCalls), newest: Math.max(bucket?.newest ?? now, now) });
    return allowed;
  }

  return { check, size: () => buckets.size };
}
