/*
 * Per-agent retention policy (ENS records nanite.otp-ttl / nanite.mail-ttl / nanite.extend / nanite.extend-limit).
 *
 * Writers (inbound pipeline, outbound sent copy) read it through a small cache (<= 60 s per agent) so a burst of mail
 * costs one ENS read, not one per mail. A failed or slow ENS read NEVER blocks mail: it falls back to the defaults
 * (OTP 5 min, mail 48 h) and is remembered for 10 s only. The extend routes read it fresh (no cache)
 * because they enforce a permission.
 */
import { DEFAULT_RETENTION, type RetentionPolicy } from "@nanite/ens";

export type RetentionRead = (ensName: string) => Promise<RetentionPolicy & { invalid?: number }>;

export interface RetentionSource {
  /** Cached (<= 60 s). Never throws: falls back to the defaults. */
  get(ensName: string): Promise<RetentionPolicy>;
  /** Fresh read, for permission checks. Throws when ENS cannot be read. */
  fresh(ensName: string): Promise<RetentionPolicy>;
}

export const RETENTION_CACHE_MS = 60_000;
export const RETENTION_READ_TIMEOUT_MS = 4_000;
const FAILURE_CACHE_MS = 10_000;

export function createRetentionSource(opts: {
  read: RetentionRead;
  /** Counts only, never record values. */
  log?: ((fields: Record<string, unknown>) => void) | undefined;
  now?: () => number;
  cacheMs?: number;
  timeoutMs?: number;
}): RetentionSource {
  const now = opts.now ?? (() => Date.now());
  const cacheMs = Math.min(opts.cacheMs ?? RETENTION_CACHE_MS, RETENTION_CACHE_MS);
  const timeoutMs = opts.timeoutMs ?? RETENTION_READ_TIMEOUT_MS;
  const cache = new Map<string, { at: number; policy: RetentionPolicy }>();
  const inflight = new Map<string, Promise<RetentionPolicy>>();

  async function readNow(ensName: string): Promise<RetentionPolicy> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("retention read timeout")), timeoutMs);
      timer.unref?.();
    });
    try {
      const r = await Promise.race([opts.read(ensName), timeout]);
      const { invalid, ...policy } = r;
      if (invalid) opts.log?.({ event: "retention_invalid_records", invalid });
      return policy;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    fresh: (ensName) => readNow(ensName),
    async get(ensName) {
      const key = ensName.toLowerCase();
      const hit = cache.get(key);
      if (hit && now() - hit.at < cacheMs) return hit.policy;
      let p = inflight.get(key);
      if (!p) {
        p = readNow(ensName).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      try {
        const policy = await p;
        cache.set(key, { at: now(), policy });
        return policy;
      } catch {
        opts.log?.({ event: "retention_read_failed", fallback: "defaults" });
        // Remember the failure for 10 s only, so an ENS outage costs one timeout per 10 s, not one per mail.
        cache.set(key, { at: now() - cacheMs + FAILURE_CACHE_MS, policy: { ...DEFAULT_RETENTION } });
        return { ...DEFAULT_RETENTION };
      }
    },
  };
}

/** Seconds a new entity of this type should live, per the agent's policy. */
export function lifetimeSeconds(type: "otp" | "conversation" | "sent", p: RetentionPolicy): number {
  return type === "otp" ? p.otpTtlMinutes * 60 : p.mailTtlHours * 3600;
}
