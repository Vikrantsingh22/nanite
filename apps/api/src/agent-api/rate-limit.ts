/** In-memory fixed-window limiter keyed by token id. Single API process only. */
export function createRateLimiter(opts: { limit?: number; windowMs?: number; now?: () => number } = {}) {
  const limit = opts.limit ?? 60;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { start: number; count: number }>();

  return {
    /** Counts one request. Returns allowed=false (with retryAfterSec) once the window is full. */
    hit(key: string): { allowed: boolean; retryAfterSec: number } {
      const t = now();
      if (buckets.size > 10_000) {
        for (const [k, b] of buckets) if (t - b.start >= windowMs) buckets.delete(k);
      }
      let b = buckets.get(key);
      if (!b || t - b.start >= windowMs) {
        b = { start: t, count: 0 };
        buckets.set(key, b);
      }
      b.count += 1;
      return {
        allowed: b.count <= limit,
        retryAfterSec: Math.max(1, Math.ceil((b.start + windowMs - t) / 1000)),
      };
    },
  };
}
export type RateLimiter = ReturnType<typeof createRateLimiter>;
