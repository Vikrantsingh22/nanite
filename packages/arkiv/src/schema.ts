// Arkiv entity schema `nanite.email.v1`. Arkiv data is PUBLIC: every plaintext column below is
// readable by anyone who can reach the chain, so each one is a deliberate trade-off (documented per
// field and in arkiv/schema.md). Rule: a column is plaintext only if a reader must FILTER or ORDER
// on it, or the reader needs it before it can decrypt. Everything else lives in the ciphertext.
import { addr, bytes, defineSchema, str, u64 } from '@arkiv-network/sdk/schema';

export const SCHEMA_NAME = 'nanite.email.v1';

export const EMAIL_TYPES = ['otp', 'conversation', 'sent'] as const;
export type EmailType = (typeof EMAIL_TYPES)[number];

/**
 * Budget for ciphertext + wrappedKeys + nonce per entity. The chain's effective cap is about
 * 128.2K bytes per create (tx size), so we keep ~3 KiB of headroom for the str attributes.
 */
export const MAX_PAYLOAD_BYTES = 125 * 1024;

export const EmailSchema = defineSchema(SCHEMA_NAME, {
  // --- indexed plaintext (queryable) ---
  // Which agent mailbox the mail belongs to (an ENS name like alex.nanitecom.eth). Public because
  // the inbox query is "agentId = X"; it links all of an agent's mail together. Accepted for the
  // demo; production can switch to opaque ids without a schema change (it is only a str).
  agentId: str().indexed(),
  // The Nanite user's wallet. Public because "all my mail across agents" is a query and the
  // browser reads Arkiv directly. It is already the entity's $owner, so it adds no new leak.
  ownerId: addr().indexed(),
  // "otp" | "conversation" | "sent". Public because it drives the retention class (minutes vs
  // months) and the "latest OTP" query. Reveals mail category only, not content.
  type: str().indexed(),
  // Unix SECONDS of receipt. Public because inboxes are ordered and range-filtered by time; the
  // entity's own $createdAt is a block number, which does not equal real receipt time.
  receivedAt: u64().indexed(),
  // Opaque conversation id (never the subject). Public because threads are queried by id; it
  // reveals thread structure and volume.
  threadId: str().indexed(),
  // Per-user HMAC blind index of the sender address (@nanite/crypto senderHash, 64 hex chars).
  // Public because "mail from this sender" is a query; the HMAC key is per user and secret, so
  // the sender address cannot be recovered or linked across users.
  senderHash: str().indexed(),
  // Comma-joined, sorted keyIds (16 hex each) of the readers who hold a wrapped key. Public
  // because a reader must know whether (and with which key) it can open the entity before
  // downloading it, and it is also bound into the AEAD associated data. Reveals who can read.
  keyIds: str().indexed(),
  // --- encrypted / opaque bytes (not indexable; share ONE ~125 KiB budget per entity) ---
  // 0x01 || XChaCha20-Poly1305(subject + body [+ raw eml]); everything about the mail content.
  ciphertext: bytes(),
  // Sealed boxes of the content key, one per reader (see @nanite/crypto wrappedKeys v1).
  wrappedKeys: bytes(),
  // 24-byte AEAD nonce.
  nonce: bytes(),
});

export const KEY_ID_RE = /^[0-9a-f]{16}$/;
export const SENDER_HASH_RE = /^[0-9a-f]{64}$/;
export const MAX_STR_BYTES = 128;

/** Canonical `keyIds` column value: lower-case, unique, sorted, comma-joined. */
export function formatKeyIds(ids: readonly string[]): string {
  const norm = [...new Set(ids.map((i) => i.toLowerCase()))].sort();
  return norm.join(',');
}

export function parseKeyIds(column: string): string[] {
  return column === '' ? [] : column.split(',');
}
