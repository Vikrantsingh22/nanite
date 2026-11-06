/*
 * Dashboard-side agent queries (session-scoped: every read and write takes the session user's id).
 * No schema changes: agent status is derived (revoked_at, resolver_address, in-memory job).
 */
import { agents, apiTokens, domains, mailboxes } from "@nanite/db";
import type { Db } from "@nanite/db";
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";

export async function ensureSharedDomain(db: Db, name: string) {
  await db.insert(domains).values({ ownerUserId: null, name, status: "verified" }).onConflictDoNothing({ target: domains.name });
  const [row] = await db.select().from(domains).where(eq(domains.name, name)).limit(1);
  if (!row) throw new Error("shared domain missing");
  return row;
}

export async function listUserAgents(db: Db, userId: string) {
  return db
    .select({
      id: agents.id,
      index: agents.derivationIndex,
      name: agents.name,
      ensName: agents.ensName,
      walletAddress: agents.walletAddress,
      custody: agents.custody,
      resolverAddress: agents.resolverAddress,
      revokedAt: agents.revokedAt,
      createdAt: agents.createdAt,
      signerAddress: agents.signerAddress,
      email: mailboxes.address,
    })
    .from(agents)
    .leftJoin(mailboxes, eq(mailboxes.agentId, agents.id))
    .where(eq(agents.userId, userId))
    .orderBy(asc(agents.derivationIndex));
}
export type AgentRow = Awaited<ReturnType<typeof listUserAgents>>[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The agent only if it belongs to `userId` (a foreign or malformed id is indistinguishable from "missing"). */
export async function getOwnedAgent(db: Db, userId: string, agentId: string): Promise<AgentRow | null> {
  if (!UUID_RE.test(agentId)) return null;
  const rows = await db
    .select({
      id: agents.id,
      index: agents.derivationIndex,
      name: agents.name,
      ensName: agents.ensName,
      walletAddress: agents.walletAddress,
      custody: agents.custody,
      resolverAddress: agents.resolverAddress,
      revokedAt: agents.revokedAt,
      createdAt: agents.createdAt,
      signerAddress: agents.signerAddress,
      email: mailboxes.address,
    })
    .from(agents)
    .leftJoin(mailboxes, eq(mailboxes.agentId, agents.id))
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function nextAgentIndex(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ idx: agents.derivationIndex })
    .from(agents)
    .where(eq(agents.userId, userId))
    .orderBy(desc(agents.derivationIndex))
    .limit(1);
  return row ? row.idx + 1 : 0;
}

function pgConstraint(e: unknown): { code?: string; constraint?: string } {
  const x = e as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
  const code = x.code ?? x.cause?.code;
  const constraint = x.constraint_name ?? x.cause?.constraint_name;
  return { ...(code ? { code } : {}), ...(constraint ? { constraint } : {}) };
}

export type InsertAgentResult =
  | { ok: true; agentId: string }
  | { ok: false; conflict: "index" | "name" | "wallet" | "mailbox" };

/** Agent row and mailbox row in one transaction. Unique violations map to a conflict reason. */
export async function insertAgentWithMailbox(
  db: Db,
  a: {
    id: string;
    userId: string;
    name: string;
    index: number;
    walletAddress: string;
    ensName: string;
    publicKey: Uint8Array;
    keyId: string;
    custody: "nanite" | "self";
    encryptedPrivateKey: Uint8Array | null;
    /** Mail-signing key (custody = nanite only): address + sealed private key. */
    signer?: { address: string; sealed: Uint8Array } | null;
    mailboxAddress: string;
    domainId: string;
  },
): Promise<InsertAgentResult> {
  try {
    await db.transaction(async (tx) => {
      await tx.insert(agents).values({
        id: a.id,
        userId: a.userId,
        name: a.name,
        derivationIndex: a.index,
        walletAddress: a.walletAddress,
        ensName: a.ensName,
        publicKey: Buffer.from(a.publicKey),
        keyId: a.keyId,
        custody: a.custody,
        encryptedPrivateKey: a.encryptedPrivateKey ? Buffer.from(a.encryptedPrivateKey) : null,
        signerAddress: a.signer ? a.signer.address.toLowerCase() : null,
        signerKeySealed: a.signer ? Buffer.from(a.signer.sealed) : null,
      });
      await tx.insert(mailboxes).values({ address: a.mailboxAddress, domainId: a.domainId, userId: a.userId, agentId: a.id });
    });
    return { ok: true, agentId: a.id };
  } catch (e) {
    const { code, constraint } = pgConstraint(e);
    if (code !== "23505") throw e;
    if (constraint === "agents_user_derivation_unique") return { ok: false, conflict: "index" };
    if (constraint === "agents_wallet_address_unique") return { ok: false, conflict: "wallet" };
    if (constraint === "mailboxes_address_unique") return { ok: false, conflict: "mailbox" };
    return { ok: false, conflict: "name" };
  }
}

export async function getAgentPublicKeyHex(db: Db, agentId: string): Promise<string> {
  const [r] = await db.select({ pk: agents.publicKey }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return Buffer.from(r!.pk).toString("hex");
}

export async function setAgentResolver(db: Db, agentId: string, resolver: string) {
  await db.update(agents).set({ resolverAddress: resolver.toLowerCase() }).where(eq(agents.id, agentId));
}

/** Stores a (new) mail-signing key: address + sealed private key. Replaces any previous one. */
export async function setAgentSigner(db: Db, agentId: string, s: { address: string; sealed: Uint8Array }) {
  await db
    .update(agents)
    .set({ signerAddress: s.address.toLowerCase(), signerKeySealed: Buffer.from(s.sealed) })
    .where(eq(agents.id, agentId));
}

/** Marks the agent revoked and cuts all access immediately: tokens revoked, mailbox disabled. */
export async function revokeAgentAccess(db: Db, agentId: string, at: Date = new Date()) {
  await db.transaction(async (tx) => {
    await tx.update(agents).set({ revokedAt: at }).where(and(eq(agents.id, agentId), isNull(agents.revokedAt)));
    await tx.update(apiTokens).set({ revokedAt: at }).where(and(eq(apiTokens.agentId, agentId), isNull(apiTokens.revokedAt)));
    await tx.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.agentId, agentId));
  });
}

/** Revokes every live token of the agent except `keepTokenId`. */
export async function revokeOtherTokens(db: Db, agentId: string, keepTokenId: string, at: Date = new Date()) {
  await db
    .update(apiTokens)
    .set({ revokedAt: at })
    .where(and(eq(apiTokens.agentId, agentId), isNull(apiTokens.revokedAt), ne(apiTokens.id, keepTokenId)));
}
