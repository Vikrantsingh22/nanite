import { and, eq, gt, isNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { authNonces, sessions, userKeys, users } from "../schema.js";

/**
 * Users exist from the first SIWE sign-in, but users.username is NOT NULL. Until a name is claimed the
 * row carries this placeholder (`pending-` + the 40 hex chars of the wallet). Real usernames may never
 * start with this prefix (enforced by the API).
 */
export const PENDING_USERNAME_PREFIX = "pending-";
export const pendingUsername = (wallet: string) => PENDING_USERNAME_PREFIX + wallet.toLowerCase().replace(/^0x/, "");
export const isPendingUsername = (name: string) => name.startsWith(PENDING_USERNAME_PREFIX);

export async function createAuthNonce(db: Db, nonce: string, expiresAt: Date) {
  await db.insert(authNonces).values({ nonce, expiresAt });
  // Opportunistic cleanup of nonces that expired more than an hour ago.
  await db.delete(authNonces).where(lt(authNonces.expiresAt, new Date(Date.now() - 3600_000)));
}

/** Atomically burns a nonce: true only the first time, and only while it has not expired. */
export async function consumeAuthNonce(db: Db, nonce: string, wallet: string): Promise<boolean> {
  const rows = await db
    .update(authNonces)
    .set({ usedAt: new Date(), walletAddress: wallet.toLowerCase() })
    .where(and(eq(authNonces.nonce, nonce), isNull(authNonces.usedAt), gt(authNonces.expiresAt, new Date())))
    .returning({ id: authNonces.id });
  return rows.length === 1;
}

export async function upsertUserByWallet(db: Db, wallet: string) {
  const w = wallet.toLowerCase();
  await db
    .insert(users)
    .values({ walletAddress: w, username: pendingUsername(w) })
    .onConflictDoNothing({ target: users.walletAddress });
  const rows = await db.select().from(users).where(eq(users.walletAddress, w)).limit(1);
  const user = rows[0];
  if (!user) throw new Error("user row vanished after upsert");
  return user;
}

export async function createSession(db: Db, userId: string, expiresAt: Date) {
  const rows = await db.insert(sessions).values({ userId, expiresAt }).returning();
  return rows[0]!;
}

export async function findSessionUser(db: Db, sessionId: string) {
  const rows = await db
    .select({ session: sessions, user: users, hasKeys: sql<boolean>`${userKeys.id} is not null` })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(userKeys, eq(userKeys.userId, users.id))
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function revokeSession(db: Db, sessionId: string) {
  await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

export interface NewUserKeys {
  publicKey: Buffer;
  keyId: string;
  walletSalt: Buffer;
  recoverySalt: Buffer;
  wrappedPrivateKeyWallet: Buffer;
  wrappedPrivateKeyRecovery: Buffer;
  wrappedSeedWallet: Buffer;
  wrappedSeedRecovery: Buffer;
  passphraseMode: boolean;
}

/** Stores the key bundle and advances started -> keys_created in one transaction. null if keys already exist. */
export async function insertUserKeys(db: Db, userId: string, keys: NewUserKeys) {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(userKeys)
      .values({ userId, ...keys })
      .onConflictDoNothing({ target: userKeys.userId })
      .returning({ id: userKeys.id });
    if (inserted.length === 0) return null;
    await tx
      .update(users)
      .set({ onboardingState: "keys_created" })
      .where(and(eq(users.id, userId), eq(users.onboardingState, "started")));
    return inserted[0]!;
  });
}

export async function getUserKeys(db: Db, userId: string) {
  const rows = await db.select().from(userKeys).where(eq(userKeys.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function isUsernameTaken(db: Db, username: string, exceptUserId?: string) {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(exceptUserId ? and(eq(users.username, username), ne(users.id, exceptUserId)) : eq(users.username, username))
    .limit(1);
  return rows.length > 0;
}

/** 'taken' on a unique violation. */
export async function setUsername(db: Db, userId: string, username: string): Promise<"ok" | "taken"> {
  try {
    await db.update(users).set({ username }).where(eq(users.id, userId));
    return "ok";
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    if (code === "23505") return "taken";
    throw e;
  }
}

/** keys_created -> name_claimed, recording the ENS name. */
export async function markNameClaimed(db: Db, userId: string, ensName: string) {
  await db
    .update(users)
    .set({ ensName: ensName.toLowerCase(), onboardingState: "name_claimed" })
    .where(and(eq(users.id, userId), eq(users.onboardingState, "keys_created")));
}

/** name_claimed -> done. */
export async function markOnboardingDone(db: Db, userId: string) {
  const rows = await db
    .update(users)
    .set({ onboardingState: "done" })
    .where(and(eq(users.id, userId), eq(users.onboardingState, "name_claimed")))
    .returning({ id: users.id });
  return rows.length === 1;
}
