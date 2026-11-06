/*
 * Browser mail proxy (T3.3): session auth, scoped to the session user's own agents.
 *
 * The server only forwards ENCRYPTED entities read through the creator-pinned Arkiv reader. It never
 * decrypts for the user (the private key lives in the browser). Every read is filtered to the agent's
 * ENS name AND to the user's wallet as both the `ownerId` attribute and the entity `$owner`, so a
 * look-alike entity written by someone else, or transferred to someone else, never shows up.
 * Nothing here logs ciphertext, keys or query strings.
 */
import { EMAIL_TYPES, type ArkivReader, type EmailRecord, type EmailType } from "@nanite/arkiv";
import { agents } from "@nanite/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createRateLimiter, type RateLimiter } from "../agent-api/rate-limit.js";
import type { ArkivWriterPort } from "../arkiv/port.js";
import { expiryFields, extendEmailEntity } from "../extend/extend.js";
import { requireSession, type AuthVars } from "../auth/session.js";
import type { AuthDeps } from "../auth/types.js";

export type MailReader = Pick<ArkivReader, "listInbox" | "getEmail">;

export interface MailDeps {
  reader: MailReader;
  /** Current chain block number, used to turn `$expiresAt` (a block) into a timestamp. Optional. */
  blockNumber?: () => Promise<bigint>;
  now?: () => Date;
  /** Operator writer used by POST /mail/:agentId/emails/:key/extend. Absent: that route answers 503. */
  arkiv?: ArkivWriterPort | undefined;
  /** Rate limiter for the Keep route (per user id). Default 30 per minute. */
  keepLimiter?: RateLimiter | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const MAX_LIMIT = 100;

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

class BadRequest extends Error {}

function intParam(v: string | undefined, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === "") return undefined;
  if (!/^\d{1,12}$/.test(v)) throw new BadRequest(`invalid_${name}`);
  const n = Number(v);
  if (n < min || n > max) throw new BadRequest(`invalid_${name}`);
  return n;
}

function typesParam(v: string | undefined): EmailType[] | undefined {
  if (!v) return undefined;
  const parts = v.split(",").map((s) => s.trim());
  for (const p of parts) if (!(EMAIL_TYPES as readonly string[]).includes(p)) throw new BadRequest("invalid_type");
  return parts as EmailType[];
}

export function mailRoutes(auth: AuthDeps, webOrigin: string, deps: MailDeps) {
  const app = new Hono<AuthVars>();
  const now = deps.now ?? (() => new Date());
  app.use("/mail/*", requireSession(auth, webOrigin));

  async function ownedAgent(userId: string, agentId: string) {
    if (!UUID_RE.test(agentId)) return null;
    const [row] = await auth.db
      .select({ id: agents.id, ensName: agents.ensName })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  async function currentBlock(): Promise<bigint | null> {
    if (!deps.blockNumber) return null;
    try {
      return await deps.blockNumber();
    } catch {
      return null;
    }
  }

  function entity(r: EmailRecord, block: bigint | null) {
    return {
      key: r.$key,
      type: r.type,
      receivedAt: r.receivedAt,
      threadId: r.threadId,
      senderHash: r.senderHash,
      keyIds: r.keyIds,
      owner: r.$owner,
      creator: r.$creator,
      ciphertext: b64(r.ciphertext),
      wrappedKeys: b64(r.wrappedKeys),
      nonce: b64(r.nonce),
      ...expiryFields(r, block, now()),
    };
  }

  app.get("/mail/:agentId/inbox", async (c) => {
    const { user } = c.get("auth");
    const agent = await ownedAgent(user.id, c.req.param("agentId"));
    if (!agent) return c.json({ error: "not_found" }, 404);
    try {
      const types = typesParam(c.req.query("type"));
      const before = intParam(c.req.query("before"), "before", 0, Number.MAX_SAFE_INTEGER);
      const limit = intParam(c.req.query("limit"), "limit", 1, MAX_LIMIT) ?? 25;
      const wallet = user.walletAddress as `0x${string}`;
      const page = await deps.reader.listInbox({
        agentId: agent.ensName,
        ownerId: wallet,
        owner: wallet,
        limit,
        ...(types ? { types } : {}),
        ...(before !== undefined ? { before } : {}),
      });
      const block = await currentBlock();
      const items = page.items
        .filter((r) => r.agentId === agent.ensName && same(r.$owner, wallet) && same(r.ownerId, wallet))
        .map((r) => entity(r, block));
      const last = page.items[page.items.length - 1];
      c.header("Cache-Control", "no-store");
      return c.json({
        items,
        skipped: page.skipped,
        ...(page.items.length >= limit && last ? { nextBefore: last.receivedAt } : {}),
      });
    } catch (e) {
      if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
      if ((e as Error).name === "InvalidEmailFieldsError") return c.json({ error: "invalid_request" }, 400);
      return c.json({ error: "upstream_unavailable" }, 502);
    }
  });

  app.get("/mail/:agentId/emails/:key", async (c) => {
    const { user } = c.get("auth");
    const agent = await ownedAgent(user.id, c.req.param("agentId"));
    const key = c.req.param("key");
    if (!agent || !KEY_RE.test(key)) return c.json({ error: "not_found" }, 404);
    try {
      const rec = await deps.reader.getEmail(key.toLowerCase() as `0x${string}`);
      const wallet = user.walletAddress;
      // Same predicate as the inbox listing: this agent's mailbox AND this user's wallet.
      if (!rec || rec.agentId !== agent.ensName || !same(rec.$owner, wallet) || !same(rec.ownerId, wallet)) {
        return c.json({ error: "not_found" }, 404);
      }
      c.header("Cache-Control", "no-store");
      return c.json(entity(rec, await currentBlock()));
    } catch (e) {
      // UntrustedEntityError (look-alike / wrong creator) is indistinguishable from "not found" to the caller.
      if ((e as Error).name === "UntrustedEntityError") return c.json({ error: "not_found" }, 404);
      return c.json({ error: "upstream_unavailable" }, 502);
    }
  });

  // Keep (extend) a conversation/sent email. The user's own action: not gated by the agent's ENS permission or daily
  // limit, but rate limited per user. The operator signs and pays.
  const keepLimiter = deps.keepLimiter ?? createRateLimiter({ limit: 30, windowMs: 60_000 });
  app.post(
    "/mail/:agentId/emails/:key/extend",
    bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "payload_too_large" }, 413) }),
    async (c) => {
      const { user } = c.get("auth");
      const agent = await ownedAgent(user.id, c.req.param("agentId"));
      const key = c.req.param("key");
      if (!agent || !KEY_RE.test(key)) return c.json({ error: "not_found" }, 404);
      const rl = keepLimiter.hit(user.id);
      if (!rl.allowed) {
        c.header("Retry-After", String(rl.retryAfterSec));
        return c.json({ error: "rate_limited" }, 429);
      }
      const body = (await c.req.json().catch(() => null)) as { days?: unknown } | null;
      if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid_request" }, 400);
      if (!deps.arkiv) return c.json({ error: "extend_unavailable" }, 503);
      const out = await extendEmailEntity(
        { reader: deps.reader, arkiv: deps.arkiv, blockNumber: deps.blockNumber, now },
        { agentEns: agent.ensName, ownerWallet: user.walletAddress },
        key,
        body.days,
      );
      c.header("Cache-Control", "no-store");
      return c.json(out.body, out.http);
    },
  );

  return app;
}
