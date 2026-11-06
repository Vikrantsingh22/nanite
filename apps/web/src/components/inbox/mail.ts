import { CryptoError, decryptEmail } from "@nanite/crypto"

import type { UnlockedKeys } from "@/lib/onboarding-crypto"

/* Encrypted entity exactly as GET /mail/:agentId/inbox returns it (binary fields are base64). */
export type MailType = "otp" | "conversation" | "sent"

export interface MailEntity {
  key: string
  type: MailType
  receivedAt: number
  threadId: string
  senderHash: string
  keyIds: string[]
  owner: string
  creator: string
  ciphertext: string
  wrappedKeys: string
  nonce: string
  expiresAtBlock: string
  expiresAt: string | null
}

export interface InboxPage {
  items: MailEntity[]
  skipped: number
  nextBefore?: number
}

/** Decrypted view of one message. Lives in React state only: never logged, never stored. */
export interface PlainMail {
  subject: string
  body: string
  otp?: string
  links: string[]
  from?: string
}

export type Decrypted = { ok: true; mail: PlainMail } | { ok: false; reason: string }

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

const REASONS: Record<string, string> = {
  NO_SLOT: "not encrypted for your key",
  DECRYPT_FAILED: "integrity check failed",
  WRONG_KEY: "wrong key",
  BAD_FORMAT: "unreadable format",
  UNSUPPORTED_VERSION: "unsupported version",
}

/** Decrypts one entity. Never throws: failures come back as a short, content-free reason. */
export async function decryptEntity(entity: MailEntity, keys: UnlockedKeys): Promise<Decrypted> {
  try {
    if (!entity.keyIds.includes(keys.keyId)) return { ok: false, reason: REASONS.NO_SLOT! }
    const plain = await decryptEmail(
      { ciphertext: unb64(entity.ciphertext), wrappedKeys: unb64(entity.wrappedKeys), nonce: unb64(entity.nonce) },
      { keyId: keys.keyId, publicKey: keys.publicKey, privateKey: keys.privateKey },
    )
    const meta = (plain.meta ?? {}) as { otp?: unknown; links?: unknown; from?: unknown }
    return {
      ok: true,
      mail: {
        subject: plain.subject,
        body: plain.body,
        ...(typeof meta.otp === "string" ? { otp: meta.otp } : {}),
        links: Array.isArray(meta.links) ? meta.links.filter((l): l is string => typeof l === "string") : [],
        ...(typeof meta.from === "string" ? { from: meta.from } : {}),
      },
    }
  } catch (e) {
    const code = e instanceof CryptoError ? e.code : ""
    return { ok: false, reason: REASONS[code] ?? "could not decrypt" }
  }
}

/** Short stable label for the sender blind index (the sender address itself is not stored). */
export const shortSender = (hash: string) => `sender ${hash.slice(0, 8)}`

export function formatTime(unixSeconds: number, nowMs: number): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds)
  if (diff < 60) return "just now"
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 7 * 86_400) return `${Math.floor(diff / 86_400)}d ago`
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

export const OTP_DEFAULT_TTL_MS = 300_000

/** Epoch ms at which an OTP stops being valid: the entity's own expiry when known, else receipt + 5 min. */
export function otpExpiry(e: MailEntity): { expiresAt: number; totalMs: number } {
  const parsed = e.expiresAt ? Date.parse(e.expiresAt) : NaN
  const expiresAt = Number.isFinite(parsed) ? parsed : e.receivedAt * 1000 + OTP_DEFAULT_TTL_MS
  return { expiresAt, totalMs: Math.max(1000, expiresAt - e.receivedAt * 1000) }
}

/** True when the body is an HTML document or fragment rather than plain text. */
export function looksLikeHtml(body: string): boolean {
  return /^\s*(<!doctype html|<html[\s>]|<body[\s>])/i.test(body) || /<(div|p|table|img|br|span|a|h[1-6]|ul|ol|style)[\s>/]/i.test(body)
}
