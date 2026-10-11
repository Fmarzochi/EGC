// Per-tool, per-project call counter behind every tool of the server:
// a key is `<project>::<tool>` when the call names a project, `<tool>`
// otherwise, and a call is allowed while the key holds at most maxCalls
// timestamps inside the window.
export interface RateLimiter {
  check(tool: string, projectPath?: string | null, now?: number): boolean;
  size(): number;
}

export function createRateLimiter({ windowMs, maxCalls }: { windowMs: number; maxCalls: number }): RateLimiter {
  const calls = new Map<string, number[]>();

  // A key whose newest call already left the window holds nothing the
  // next check can use, so it goes; the map stays bounded by the keys
  // active in the last window instead of growing for the life of the
  // process (#1682).
  function evictIdle(now: number): void {
    for (const [key, stamps] of calls) {
      if (stamps.length === 0 || now - stamps[stamps.length - 1] >= windowMs) calls.delete(key);
    }
  }

  function check(tool: string, projectPath?: string | null, now: number = Date.now()): boolean {
    evictIdle(now);
    const trimmed = projectPath ? projectPath.trim() : '';
    const key = trimmed !== '' ? `${trimmed}::${tool}` : tool;
    const stamps = (calls.get(key) ?? []).filter(t => now - t < windowMs);
    stamps.push(now);
    calls.set(key, stamps);
    return stamps.length <= maxCalls;
  }

  return { check, size: () => calls.size };
}
