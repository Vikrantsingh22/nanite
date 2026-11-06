// Draft schema nanite.email.v0 (see claude/nanite-project-summary.md "Encryption design").
// Rule: anything a reader must FILTER on is an indexed plaintext column; everything else is
// ciphertext. Plaintext columns leak volume/timing/thread structure, by design (documented).
import { defineSchema, str, addr, u64, bytes } from "@arkiv-network/sdk/schema";

export const EmailSchema = defineSchema("nanite.email.v0", {
  // --- indexed (queryable) ---
  agentId: str().indexed(), // agent identifier (e.g. ENS label or agent address); each agent reads only its own mail
  ownerId: addr().indexed(), // the Nanite USER wallet (not necessarily $owner of the entity, which may be an operator/writer)
  type: str().indexed(), // "otp" | "conversation": drives expiry class (minutes vs months)
  receivedAt: u64().indexed(), // unix seconds; entity $createdAt is a block number, so keep real time explicitly
  threadId: str().indexed(), // conversation grouping (opaque id, not the subject)
  senderHash: str().indexed(), // hex HMAC-SHA256(secret, lowercased sender): blind index, 64 hex chars fits in 128B
  keyId: str().indexed(), // which key version wrapped the content key (rotation / lookup)
  // --- not indexed (bytes cannot be indexed; all bytes share ONE 128 KiB budget per create) ---
  // AEAD ciphertext of subject + body + raw .eml (XChaCha20-Poly1305/AES-256-GCM). If the 128 KiB budget is tight, drop the raw
  // .eml or split into extra entities.
  ciphertext: bytes(),
  // Sealed boxes of the content key, one per reader (user, agent): ~80 B each. Kept separate so grants can be PATCHED
  // (add/remove a reader) without rewriting the ciphertext.
  wrappedKeys: bytes(),
  // AEAD nonce (12 or 24 B). Could be prefixed to ciphertext to save an attribute; kept separate for clarity.
  nonce: bytes(),
});

export const EMAIL_TYPES = ["otp", "conversation"] as const;
