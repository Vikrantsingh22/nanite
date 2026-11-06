/*
 * user_domains queries (T3.6). Every read that serves a user is scoped by user_id; the background verifier and
 * the webhook use the id-based variants. Only public DNS data lives here (Resend's records, our DNS lookups).
 */
import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { domains, userDomains } from "../schema.js";

export type UserDomainRow = typeof userDomains.$inferSelect;

export interface NewUserDomain {
  userId: string;
  name: string;
  resendDomainId: string;
  region: string;
  status: string;
  records: unknown[];
}

export async function getUserDomain(db: Db, userId: string): Promise<UserDomainRow | null> {
  const rows = await db.select().from(userDomains).where(eq(userDomains.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function getUserDomainById(db: Db, id: string): Promise<UserDomainRow | null> {
  const rows = await db.select().from(userDomains).where(eq(userDomains.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getUserDomainByResendId(db: Db, resendDomainId: string): Promise<UserDomainRow | null> {
  const rows = await db.select().from(userDomains).where(eq(userDomains.resendDomainId, resendDomainId)).limit(1);
  return rows[0] ?? null;
}

/** True when the name is already used by a user domain of someone else or by any `domains` row (shared or user). */
export async function isMailDomainTaken(db: Db, name: string, exceptUserId?: string): Promise<boolean> {
  const mine = await db
    .select({ id: userDomains.id })
    .from(userDomains)
    .where(exceptUserId ? and(eq(userDomains.name, name), ne(userDomains.userId, exceptUserId)) : eq(userDomains.name, name))
    .limit(1);
  if (mine.length > 0) return true;
  const shared = await db
    .select({ id: domains.id, owner: domains.ownerUserId })
    .from(domains)
    .where(eq(domains.name, name))
    .limit(1);
  const row = shared[0];
  if (!row) return false;
  return !(exceptUserId && row.owner === exceptUserId);
}

/** Inserts the row. null when the user already has one or the name is taken (unique violations). */
export async function insertUserDomain(db: Db, d: NewUserDomain): Promise<UserDomainRow | null> {
  const rows = await db
    .insert(userDomains)
    .values({
      userId: d.userId,
      name: d.name,
      resendDomainId: d.resendDomainId,
      region: d.region,
      status: d.status,
      records: d.records,
      verifiedAt: d.status === "verified" ? new Date() : null,
    })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

export interface UserDomainPatch {
  status?: string;
  records?: unknown[];
  dnsCheck?: unknown;
  lastVerifyRequestedAt?: Date;
}

/** Applies a patch by row id. `verified_at` is set the first time the status becomes verified and cleared otherwise. */
export async function updateUserDomain(db: Db, id: string, patch: UserDomainPatch): Promise<UserDomainRow | null> {
  const set: Record<string, unknown> = {};
  if (patch.status !== undefined) {
    set.status = patch.status;
    set.verifiedAt = patch.status === "verified" ? sql`coalesce(${userDomains.verifiedAt}, now())` : null;
  }
  if (patch.records !== undefined) set.records = patch.records;
  if (patch.dnsCheck !== undefined) set.dnsCheck = patch.dnsCheck;
  if (patch.lastVerifyRequestedAt !== undefined) set.lastVerifyRequestedAt = patch.lastVerifyRequestedAt;
  if (Object.keys(set).length === 0) return getUserDomainById(db, id);
  const rows = await db.update(userDomains).set(set as Partial<typeof userDomains.$inferInsert>).where(eq(userDomains.id, id)).returning();
  return rows[0] ?? null;
}

/**
 * Atomically claims the "verify now" slot: succeeds only if no verify was requested within `minGapMs`.
 * Returns the row (with the new timestamp) or null when rate limited.
 */
export async function claimVerifySlot(db: Db, id: string, now: Date, minGapMs: number): Promise<UserDomainRow | null> {
  const cutoff = new Date(now.getTime() - minGapMs);
  const rows = await db
    .update(userDomains)
    .set({ lastVerifyRequestedAt: now })
    .where(and(eq(userDomains.id, id), or(isNull(userDomains.lastVerifyRequestedAt), lt(userDomains.lastVerifyRequestedAt, cutoff))))
    .returning();
  return rows[0] ?? null;
}

export async function deleteUserDomain(db: Db, id: string): Promise<void> {
  await db.delete(userDomains).where(eq(userDomains.id, id));
}

/** Domains the background verifier still has to look at (anything not verified). */
export async function listUnverifiedUserDomains(db: Db): Promise<UserDomainRow[]> {
  return db.select().from(userDomains).where(ne(userDomains.status, "verified"));
}

/** The `domains` row mailboxes point at, for a user's verified mail domain. Created on demand. */
export async function ensureUserMailDomain(db: Db, userId: string, name: string, resendDomainId: string) {
  await db
    .insert(domains)
    .values({ ownerUserId: userId, name, status: "verified", resendDomainId })
    .onConflictDoNothing({ target: domains.name });
  const [row] = await db.select().from(domains).where(eq(domains.name, name)).limit(1);
  if (!row) throw new Error("user mail domain missing");
  return row;
}
