import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { agents, apiTokens, auditLog } from "../schema.js";

/** Token + agent facts needed to authenticate an agent request. No key material. */
export async function findAgentByTokenHash(db: Db, tokenHash: string) {
  const rows = await db
    .select({
      tokenId: apiTokens.id,
      tokenExpiresAt: apiTokens.expiresAt,
      tokenRevokedAt: apiTokens.revokedAt,
      agentId: agents.id,
      userId: agents.userId,
      agentName: agents.name,
      ensName: agents.ensName,
      custody: agents.custody,
      keyId: agents.keyId,
      publicKey: agents.publicKey,
      agentRevokedAt: agents.revokedAt,
    })
    .from(apiTokens)
    .innerJoin(agents, eq(agents.id, apiTokens.agentId))
    .where(eq(apiTokens.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export async function touchApiToken(db: Db, tokenId: string, at: Date = new Date()) {
  await db.update(apiTokens).set({ lastUsedAt: at }).where(eq(apiTokens.id, tokenId));
}

export async function insertApiToken(
  db: Db,
  input: { agentId: string; tokenHash: string; label?: string | null; expiresAt?: Date | null },
) {
  const [row] = await db
    .insert(apiTokens)
    .values({
      agentId: input.agentId,
      tokenHash: input.tokenHash,
      label: input.label ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning({ id: apiTokens.id });
  if (!row) throw new Error("api_tokens insert returned no row");
  return row;
}

export async function revokeApiToken(db: Db, tokenId: string, at: Date = new Date()) {
  await db.update(apiTokens).set({ revokedAt: at }).where(eq(apiTokens.id, tokenId));
}

/** Encrypted private key blob (custody = nanite only). Fetched only when a decrypt is needed. */
export async function getAgentEncryptedKey(db: Db, agentId: string) {
  const [row] = await db
    .select({ encryptedPrivateKey: agents.encryptedPrivateKey })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row?.encryptedPrivateKey ?? null;
}

export async function setAgentNaniteKey(
  db: Db,
  agentId: string,
  key: { publicKey: Uint8Array; keyId: string; encryptedPrivateKey: Uint8Array },
) {
  await db
    .update(agents)
    .set({
      custody: "nanite",
      publicKey: Buffer.from(key.publicKey),
      keyId: key.keyId,
      encryptedPrivateKey: Buffer.from(key.encryptedPrivateKey),
    })
    .where(eq(agents.id, agentId));
}

/** audit_log label of an agent email extension; with status 200 the row counts toward the daily limit. */
export const EXTEND_AUDIT_ENDPOINT = "extend";

/**
 * Atomic "check the daily extension limit, then reserve one". Counts audit_log rows labelled `extend` with status 200
 * since `dayStart` (UTC midnight) under a transaction-scoped advisory lock per agent (same technique as reserveSend),
 * so parallel calls cannot overshoot `limit`. No schema change: the reservation IS the audit row. Release it with
 * `releaseExtend` when the chain write fails, so a failed extension does not use up the day's allowance.
 */
export async function reserveExtend(
  db: Db,
  input: { agentId: string; limit: number; dayStart: Date },
): Promise<{ ok: true; id: string; used: number } | { ok: false; used: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"nanite/extend/agent/" + input.agentId}, 0))`);
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.agentId, input.agentId),
          eq(auditLog.endpoint, EXTEND_AUDIT_ENDPOINT),
          eq(auditLog.statusCode, 200),
          gte(auditLog.createdAt, input.dayStart),
        ),
      );
    const used = row?.n ?? 0;
    if (used >= input.limit) return { ok: false, used } as const;
    const [ins] = await tx
      .insert(auditLog)
      .values({ agentId: input.agentId, endpoint: EXTEND_AUDIT_ENDPOINT, statusCode: 200 })
      .returning({ id: auditLog.id });
    if (!ins) throw new Error("audit_log insert returned no row");
    return { ok: true, id: ins.id, used: used + 1 } as const;
  });
}

/** Turn a reserved extension into a failed one (status 502): it no longer counts toward the daily limit. */
export async function releaseExtend(db: Db, reservationId: string) {
  await db.update(auditLog).set({ statusCode: 502 }).where(eq(auditLog.id, reservationId));
}

/** Extensions used today (UTC) by an agent. */
export async function countExtendsSince(db: Db, agentId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(and(eq(auditLog.agentId, agentId), eq(auditLog.endpoint, EXTEND_AUDIT_ENDPOINT), eq(auditLog.statusCode, 200), gte(auditLog.createdAt, since)));
  return row?.n ?? 0;
}

/** Audit row: agent, endpoint label and status only. Never bodies, queries or content. */
export async function insertAuditLog(
  db: Db,
  row: { agentId: string | null; endpoint: string; statusCode: number },
) {
  await db.insert(auditLog).values(row);
}
