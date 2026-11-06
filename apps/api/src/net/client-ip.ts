import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/** TRUST_PROXY=1: the API sits behind exactly one reverse proxy (Caddy) that sets X-Forwarded-For. */
export function trustProxyFromEnv(source: Record<string, string | undefined> = process.env): boolean {
  return source.TRUST_PROXY?.trim() === "1";
}

const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * Client address for rate limiting.
 * - trustProxy=false: the socket address only; X-Forwarded-For is ignored (a client could forge it).
 * - trustProxy=true: the RIGHTMOST X-Forwarded-For entry, i.e. the address the single trusted proxy saw. Earlier entries
 *   are client-supplied and ignored. Falls back to the socket address when the header is absent or malformed.
 */
export function clientIp(c: Context, trustProxy: boolean, socketIp?: string): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    const last = xff?.split(",").pop()?.trim();
    if (last && IP_RE.test(last)) return last;
  }
  if (socketIp) return socketIp;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
