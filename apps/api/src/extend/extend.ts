/*
 * Keep a piece of mail longer: POST /v1/emails/:key/extend (agent token) and POST /mail/:agentId/emails/:key/extend
 * (user session). Both go through extendEmailEntity so the rules live in one place.
 *
 * No decryption is involved (hosted and self-hosted agents alike): the operator only moves an expiry. The operator
 * pays for the transaction, serialised with all other writes by the single-flight Arkiv writer queue.
 *
 * Rules: the entity must be this agent's (creator-pinned reader, agentId, $owner and ownerId = the user wallet);
 * conversation|sent only (OTPs are never extendable); days 1..182; the new expiry is NOW + days (blocks), never
 * shorter than the current one ("unchanged"). Agents additionally need ENS `nanite.extend` = on and are limited to
 * `nanite.extend-limit` extensions per UTC day (atomic, counted in audit_log). Nothing here logs mail content.
 */
import type { EmailRecord } from "@nanite/arkiv";
import { releaseExtend, reserveExtend, utcDayStart, type Db } from "@nanite/db";
import type { ArkivWriterPort } from "../arkiv/port.js";
import type { RetentionSource } from "../retention.js";

export const BLOCK_SECONDS = 2;
export const BLOCKS_PER_DAY = 43_200;
/** Arkiv maximum lifetime in blocks (about 182.5 days). */
export const MAX_LIFETIME_BLOCKS = 7_884_000n;
export const MIN_EXTEND_DAYS = 1;
export const MAX_EXTEND_DAYS = 182;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Estimated wall-clock expiry from the block numbers (2 s blocks). */
export function estimateExpiresAt(expiresAtBlock: bigint, block: bigint | null, now: Date): string | null {
  if (block === null) return null;
  return new Date(now.getTime() + Number(expiresAtBlock - block) * BLOCK_SECONDS * 1000).toISOString();
}

/** The three fields every email read carries. */
export function expiryFields(r: Pick<EmailRecord, "$expiresAt" | "type">, block: bigint | null, now: Date) {
  return {
    expiresAtBlock: r.$expiresAt.toString(),
    expiresAt: estimateExpiresAt(r.$expiresAt, block, now),
    extendable: r.type !== "otp",
  };
}

export interface ExtendDeps {
  reader: { getEmail(k: `0x${string}`): Promise<EmailRecord | null> };
  arkiv: ArkivWriterPort;
  blockNumber?: (() => Promise<bigint>) | undefined;
  now: () => Date;
}

/** Agent callers: permission (ENS) + daily limit (audit_log). Absent for the user route. */
export interface ExtendAgentGate {
  db: Db;
  agentId: string;
  retention: RetentionSource | undefined;
}

export type ExtendBody = { status: "extended" | "unchanged"; expiresAtBlock: string; expiresAt: string | null };
export type ExtendOutcome =
  | { http: 200; body: ExtendBody }
  | { http: 400 | 403 | 404 | 409 | 429 | 502 | 503; body: { error: string } };

const fail = (http: 400 | 403 | 404 | 409 | 429 | 502 | 503, error: string): ExtendOutcome => ({ http, body: { error } });

export function parseDays(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_EXTEND_DAYS && v <= MAX_EXTEND_DAYS ? v : null;
}

export async function extendEmailEntity(
  deps: ExtendDeps,
  scope: { agentEns: string; ownerWallet: string },
  entityKey: string,
  daysRaw: unknown,
  gate?: ExtendAgentGate,
): Promise<ExtendOutcome> {
  const days = parseDays(daysRaw);
  if (days === null) return fail(400, "invalid_days");
  if (!deps.arkiv.extendEmail || !deps.blockNumber) return fail(503, "extend_unavailable");
  const key = entityKey.toLowerCase() as `0x${string}`;

  // 1. The entity must be this agent's and this user's. Anything else looks like a missing entity.
  let rec: EmailRecord | null;
  try {
    rec = await deps.reader.getEmail(key);
  } catch (e) {
    if ((e as Error).name === "UntrustedEntityError") return fail(404, "not_found");
    return fail(502, "upstream_unavailable");
  }
  if (!rec || !same(rec.agentId, scope.agentEns) || !same(rec.$owner, scope.ownerWallet) || !same(rec.ownerId, scope.ownerWallet)) {
    return fail(404, "not_found");
  }
  // 2. OTPs are never extendable.
  if (rec.type !== "conversation" && rec.type !== "sent") return fail(409, "otp_not_extendable");

  // 3. Agent permission, fresh from ENS (fails closed).
  let limit = Number.POSITIVE_INFINITY;
  if (gate) {
    if (!gate.retention) return fail(503, "extend_unavailable");
    try {
      const p = await gate.retention.fresh(scope.agentEns);
      if (p.extend !== "on") return fail(403, "extend_disabled");
      limit = p.extendLimit;
    } catch {
      return fail(502, "policy_unavailable");
    }
  }

  // 4. Never shorten: compare against the current block.
  const now = deps.now();
  let block: bigint;
  try {
    block = await deps.blockNumber();
  } catch {
    return fail(502, "upstream_unavailable");
  }
  let target = block + BigInt(days) * BigInt(BLOCKS_PER_DAY);
  if (target - block > MAX_LIFETIME_BLOCKS) target = block + MAX_LIFETIME_BLOCKS;
  const unchanged = (r: EmailRecord): ExtendOutcome => ({
    http: 200,
    body: { status: "unchanged", expiresAtBlock: r.$expiresAt.toString(), expiresAt: estimateExpiresAt(r.$expiresAt, block, now) },
  });
  if (rec.$expiresAt >= target) return unchanged(rec);

  // 5. Daily limit (agents), atomic under an advisory lock. The reservation is released if the chain write fails.
  let reservation: string | undefined;
  if (gate) {
    const r = await reserveExtend(gate.db, { agentId: gate.agentId, limit, dayStart: utcDayStart(now) });
    if (!r.ok) return fail(429, "extend_limit");
    reservation = r.id;
  }

  // 6. The operator signs and pays (single-flight writer queue).
  try {
    const res = await deps.arkiv.extendEmail(key, days * 86_400);
    const newBlock = res.expiresAtBlock ?? target;
    return {
      http: 200,
      body: { status: "extended", expiresAtBlock: newBlock.toString(), expiresAt: estimateExpiresAt(newBlock, block, now) },
    };
  } catch (e) {
    if (reservation) await releaseExtend(gate!.db, reservation).catch(() => undefined);
    // A parallel, longer extension won the race: the chain refuses to shorten, which is the "unchanged" case.
    if (/ExpiryNotExtended/.test(String((e as Error)?.message))) {
      const fresh = await deps.reader.getEmail(key).catch(() => null);
      return unchanged(fresh ?? rec);
    }
    return fail(502, "extend_failed");
  }
}
