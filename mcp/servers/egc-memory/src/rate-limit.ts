// A per-tool, per-project limit on the calls this server answers (#2142): an
// honest session never reaches it, a looping agent or a runaway script gets a
// clear refusal instead of hammering the state store or the session bus. One
// sliding window per key, the keys of callers that went quiet dropped as the
// others are looked at, so the map never outgrows the live callers.

export interface RateLimitSettings {
  windowMs: number;
  maxCalls: number;
}

export interface RateLimiter {
  check(tool: string, projectPath?: string | null, now?: number): boolean;
  size(): number;
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

export function createRateLimiter(settings: RateLimitSettings): RateLimiter {
  const recent = new Map<string, number[]>();

  function check(tool: string, projectPath?: string | null, now: number = Date.now()): boolean {
    const key = `${(projectPath ?? '').trim()}::${tool}`;
    const live = (recent.get(key) ?? []).filter(stamp => now - stamp < settings.windowMs);
    live.push(now);
    recent.set(key, live);
    for (const [other, stamps] of recent) {
      if (other !== key && now - stamps[stamps.length - 1] >= settings.windowMs) recent.delete(other);
    }
    return live.length <= settings.maxCalls;
  }

  return { check, size: () => recent.size };
}
