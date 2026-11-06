/*
 * Agent API tokens: `nan_` + base64url(32 random bytes). Shown once; only the SHA-256 hex is stored.
 * Lookup is by hash (a unique index), so no secret-dependent string comparison happens in app code.
 */
import { createHash, randomBytes } from "node:crypto";
import { findAgentByTokenHash, insertApiToken, type Db } from "@nanite/db";

export const TOKEN_PREFIX = "nan_";
const TOKEN_RE = /^nan_[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function looksLikeToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Returns the plaintext token ONCE. Callers must show it to the user and drop it. */
export async function issueAgentToken(
  db: Db,
  agentId: string,
  opts: { label?: string; expiresAt?: Date } = {},
) {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const row = await insertApiToken(db, {
    agentId,
    tokenHash: hashToken(token),
    label: opts.label ?? null,
    expiresAt: opts.expiresAt ?? null,
  });
  return { token, tokenId: row.id };
}

export interface AuthedAgent {
  tokenId: string;
  agentId: string;
  userId: string;
  ensName: string;
  custody: "nanite" | "self";
  keyId: string;
  publicKey: Uint8Array;
}

export type AuthResult =
  | { ok: true; agent: AuthedAgent }
  | { ok: false; agentId: string | null };

/** Valid only if the token exists, is unrevoked and unexpired, and its agent is not revoked. */
export async function verifyAgentToken(db: Db, token: string | undefined, now: Date): Promise<AuthResult> {
  if (!token || !looksLikeToken(token)) return { ok: false, agentId: null };
  const row = await findAgentByTokenHash(db, hashToken(token));
  if (!row) return { ok: false, agentId: null };
  if (row.tokenRevokedAt || row.agentRevokedAt) return { ok: false, agentId: row.agentId };
  if (row.tokenExpiresAt && row.tokenExpiresAt.getTime() <= now.getTime()) {
    return { ok: false, agentId: row.agentId };
  }
  return {
    ok: true,
    agent: {
      tokenId: row.tokenId,
      agentId: row.agentId,
      userId: row.userId,
      ensName: row.ensName,
      custody: row.custody,
      keyId: row.keyId,
      publicKey: new Uint8Array(row.publicKey),
    },
  };
}
