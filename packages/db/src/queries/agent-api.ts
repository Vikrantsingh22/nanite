import { eq } from "drizzle-orm";
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

/** Audit row: agent, endpoint label and status only. Never bodies, queries or content. */
export async function insertAuditLog(
  db: Db,
  row: { agentId: string | null; endpoint: string; statusCode: number },
) {
  await db.insert(auditLog).values(row);
}
