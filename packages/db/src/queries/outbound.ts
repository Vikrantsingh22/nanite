/*
 * Outbound send (T3.5) queries. No schema changes: send_log holds a recipient HMAC, the decision and a
 * policy snapshot; arkiv_writes (kind = "sent", webhook_event_id/mailbox_id null) is the sent-copy ledger,
 * keyed by payload_ref = "send:<send_log.id>". No addresses, subjects or bodies are ever stored here.
 */
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { agents, arkivWrites, mailboxes, sendLog, userKeys, users, webhookEvents } from "../schema.js";

/** Everything needed to send for, and store a sent copy of, one agent. Public keys only. */
export async function findSendContext(db: Db, agentId: string) {
  const rows = await db
    .select({
      agentId: agents.id,
      agentName: agents.name,
      ensName: agents.ensName,
      agentKeyId: agents.keyId,
      agentPublicKey: agents.publicKey,
      signerAddress: agents.signerAddress,
      signerKeySealed: agents.signerKeySealed,
      userId: users.id,
      userWalletAddress: users.walletAddress,
      userKeyId: userKeys.keyId,
      userPublicKey: userKeys.publicKey,
      mailboxAddress: mailboxes.address,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .leftJoin(userKeys, eq(userKeys.userId, users.id))
    .leftJoin(mailboxes, and(eq(mailboxes.agentId, agents.id), eq(mailboxes.status, "active")))
    .where(eq(agents.id, agentId))
    .limit(1);
  return rows[0] ?? null;
}

/** Allowed sends since `since` (the daily cap counts these; denied rows do not). */
export async function countAllowedSendsSince(db: Queryable,agentId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sendLog)
    .where(and(eq(sendLog.agentId, agentId), eq(sendLog.policyDecision, "allowed"), gte(sendLog.createdAt, since)));
  return row?.n ?? 0;
}

/** A Db or the transaction handle passed to a `db.transaction` callback. */
type Queryable = Pick<Db, "select" | "insert" | "update" | "execute">;

/** UTC midnight of the day containing `now`. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Nanite-wide mail counted against the daily quota since `since`:
 *  - sent = allowed send_log rows (denied rows, including quota refusals, never count);
 *  - received = webhook_events rows created since `since`. There is one row per provider event id (unique),
 *    so retries and duplicate webhooks are not counted twice; dropped events count too, because the
 *    provider (Resend) counts every received mail against its own limit.
 */
export async function countMailSince(db: Queryable, since: Date): Promise<{ sent: number; received: number }> {
  const [s] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sendLog)
    .where(and(eq(sendLog.policyDecision, "allowed"), gte(sendLog.createdAt, since)));
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(webhookEvents)
    .where(gte(webhookEvents.createdAt, since));
  return { sent: s?.n ?? 0, received: r?.n ?? 0 };
}

export type ReserveSendResult =
  | { ok: true; id: string; used: number }
  | { ok: false; reason: "daily_limit" | "quota_exhausted"; used: number };

/**
 * Atomic "check the limits, then record the send". One transaction holds transaction-scoped advisory locks,
 * so concurrent sends cannot both pass a check that only one of them fits under:
 *  1. a global lock (only when a Nanite-wide quota is configured), then
 *  2. a per-agent lock.
 * Locks are always taken in this order (no deadlocks) and released at commit/rollback. The count and the
 * insert of the "allowed" send_log row happen under the lock; a refusal inserts a "denied" row instead
 * (which counts toward neither limit). `snapshot(extra)` builds the policy snapshot stored with the row.
 */
export async function reserveSend(
  db: Db,
  input: {
    agentId: string;
    recipientHash: string;
    agentLimit: number;
    /** Nanite-wide cap on sent + received per UTC day; undefined disables the global check. */
    quota?: number | undefined;
    dayStart: Date;
    snapshot: (extra: Record<string, unknown>) => unknown;
  },
): Promise<ReserveSendResult> {
  return db.transaction(async (tx) => {
    if (input.quota !== undefined) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('nanite/send/global', 0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"nanite/send/agent/" + input.agentId}, 0))`);

    const used = await countAllowedSendsSince(tx, input.agentId, input.dayStart);
    const deny = async (reason: "daily_limit" | "quota_exhausted", extra: Record<string, unknown>) => {
      await insertSendLog(tx, {
        agentId: input.agentId,
        recipientHash: input.recipientHash,
        decision: "denied",
        policySnapshot: input.snapshot({ reason, used, ...extra }),
      });
      return { ok: false, reason, used } as const;
    };
    if (used >= input.agentLimit) return deny("daily_limit", {});
    if (input.quota !== undefined) {
      const c = await countMailSince(tx, input.dayStart);
      if (c.sent + c.received >= input.quota) return deny("quota_exhausted", { sent: c.sent, received: c.received, quota: input.quota });
    }
    const row = await insertSendLog(tx, {
      agentId: input.agentId,
      recipientHash: input.recipientHash,
      decision: "allowed",
      policySnapshot: input.snapshot({ used: used + 1 }),
    });
    return { ok: true, id: row.id, used: used + 1 } as const;
  });
}

export async function insertSendLog(
  db: Queryable,
  row: { agentId: string; recipientHash: string; decision: "allowed" | "denied"; policySnapshot: unknown },
) {
  const [r] = await db
    .insert(sendLog)
    .values({
      agentId: row.agentId,
      recipientHash: row.recipientHash,
      policyDecision: row.decision,
      policySnapshot: row.policySnapshot as never,
    })
    .returning({ id: sendLog.id });
  if (!r) throw new Error("send_log insert returned no row");
  return r;
}

export async function setSendLogProviderId(db: Db, sendLogId: string, providerMessageId: string) {
  await db.update(sendLog).set({ providerMessageId }).where(eq(sendLog.id, sendLogId));
}

/**
 * A send that ultimately failed at the provider: the reserved "allowed" row is turned into a "denied" one
 * (reason `send_failed`, plus the fixed error token), so it counts toward neither the per-agent cap nor the
 * Nanite-wide quota (both count allowed rows only). No schema change: the decision enum and the snapshot
 * already exist. Rows that already carry a provider message id are left alone.
 */
export async function markSendFailed(db: Db, sendLogId: string, errorCode: string) {
  await db
    .update(sendLog)
    .set({
      policyDecision: "denied",
      policySnapshot: sql`coalesce(${sendLog.policySnapshot}, '{}'::jsonb) || ${JSON.stringify({ reason: "send_failed", sendFailed: true, error: errorCode })}::jsonb`,
    })
    .where(and(eq(sendLog.id, sendLogId), eq(sendLog.policyDecision, "allowed"), isNull(sendLog.providerMessageId)));
}

/** Sent-copy ledger row for a send (idempotent: one row per send_log id). */
export async function claimSentLedger(db: Db, sendLogId: string) {
  const ref = `send:${sendLogId}`;
  const [existing] = await db
    .select({ id: arkivWrites.id, status: arkivWrites.status, entityKey: arkivWrites.entityKey })
    .from(arkivWrites)
    .where(and(eq(arkivWrites.kind, "sent"), eq(arkivWrites.payloadRef, ref)))
    .limit(1);
  if (existing) {
    await db
      .update(arkivWrites)
      .set({ attempts: sql`${arkivWrites.attempts} + 1` })
      .where(eq(arkivWrites.id, existing.id));
    return existing;
  }
  const [row] = await db
    .insert(arkivWrites)
    .values({ kind: "sent", status: "submitted", payloadRef: ref, attempts: 1 })
    .returning({ id: arkivWrites.id, status: arkivWrites.status, entityKey: arkivWrites.entityKey });
  if (!row) throw new Error("arkiv_writes insert returned no row");
  return row;
}

export async function finishSentLedger(
  db: Db,
  ledgerId: string,
  r: { status: "confirmed"; entityKey: string; txHash: string } | { status: "failed"; lastError: string },
) {
  await db
    .update(arkivWrites)
    .set(
      r.status === "confirmed"
        ? { status: "confirmed", entityKey: r.entityKey, txHash: r.txHash, lastError: null }
        : { status: "failed", lastError: r.lastError },
    )
    .where(eq(arkivWrites.id, ledgerId));
}
