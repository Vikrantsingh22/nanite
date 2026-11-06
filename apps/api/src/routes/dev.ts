/*
 * DEV ONLY. Mounted by createApp only when `deps.devInbox` is set, which index.ts does only when
 * NODE_ENV !== "production" AND DEV_ROUTES=1 AND a real Arkiv writer is configured.
 * Lists Arkiv inbox METADATA straight from the chain reader. It never returns ciphertext or any
 * decrypted content. Not an API: remove or keep gated; the real inbox is /v1/* (T1.4).
 */
import { Hono } from "hono";

export interface DevInboxItem {
  key: string;
  type: string;
  receivedAt: number;
  $owner: string;
  $creator: string;
  $expiresAt: string;
}

export interface DevInbox {
  list(agentEns: string, limit: number): Promise<DevInboxItem[]>;
}

/** DEV ONLY (fake provider): the From address and headers of recent fake sends. Never subject, body or recipient. */
export interface DevOutbox {
  recent(limit: number): Array<{ from: string; headers: Record<string, string> }>;
}

export function devOutboxRoutes(devOutbox: DevOutbox) {
  const app = new Hono();
  app.get("/internal/dev/outbox", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 5) || 5, 1), 50);
    return c.json({ dev: true, items: devOutbox.recent(limit) });
  });
  return app;
}

const ENS_RE =/^[a-z0-9.-]{3,128}$/;

export function devRoutes(devInbox: DevInbox) {
  const app = new Hono();
  app.get("/internal/dev/inbox/:agentEns", async (c) => {
    const agentEns = c.req.param("agentEns").toLowerCase();
    if (!ENS_RE.test(agentEns)) return c.json({ error: "bad_request" }, 400);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25) || 25, 1), 100);
    const items = await devInbox.list(agentEns, limit);
    return c.json({ dev: true, agentEns, count: items.length, items });
  });
  return app;
}
