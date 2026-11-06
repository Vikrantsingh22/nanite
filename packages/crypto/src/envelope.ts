// Envelope encryption of one email (format documented in README.md).
import { CryptoError, concat, randomBytes, ready, s, toHex, u32be, utf8 } from './core';

export const ENVELOPE_VERSION = 1;
export const WRAPPED_KEYS_VERSION = 1;
const KEYID_BYTES = 8; // 16 hex chars
const SEALED_KEY_BYTES = 80; // 32 + crypto_box_SEALBYTES (48)
const SLOT_BYTES = KEYID_BYTES + SEALED_KEY_BYTES;
const AD_PREFIX = utf8('nanite/email/v1|');

/** Structured agent fields carried inside the encrypted payload (never plaintext attributes). */
export interface EmailMeta {
  otp?: string;
  links?: string[];
  /** Parsed From address of an inbound mail (lowercase, no display name). */
  from?: string;
  /** Recipient address of a sent mail. */
  to?: string;
  /**
   * Message-ID header of the mail as it exists in mailboxes, e.g. "<abc@example.com>". Inbound: the sender's id.
   * Sent copies: the id the PROVIDER assigned on delivery (Resend/SES replace ours), when it could be fetched.
   */
  messageId?: string;
  /** Sent copies: our own id (the signed X-Nanite-Message-Id header, `<sendLogId@domain>`). */
  naniteMessageId?: string;
  /** Original References header ids (message ids, oldest first) of an inbound mail. */
  references?: string[];
  /** Sent copies of replies: the Message-ID this mail answered (the In-Reply-To header value). */
  inReplyTo?: string;
  /** "sent" on copies of outbound mail. */
  direction?: 'sent';
}
export interface PlainEmail {
  subject: string;
  body: string;
  rawEml?: Uint8Array;
  /** Optional structured fields, stored as UTF-8 JSON (flags bit1). */
  meta?: EmailMeta;
}
export interface DecryptedEmail {
  subject: string;
  body: string;
  rawEml?: Uint8Array;
  meta?: EmailMeta;
}
const FLAG_RAW_EML = 1;
const FLAG_META = 2;
const KNOWN_FLAGS = FLAG_RAW_EML | FLAG_META;
export interface Recipient {
  keyId: string;
  publicKey: Uint8Array;
}
export interface EncryptedEmail {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  wrappedKeys: Uint8Array;
  /** sorted, hex; store `keyIds.join(',')` in the entity's keyId column if one string is needed */
  keyIds: string[];
}
export interface EmailEntityBytes {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  wrappedKeys: Uint8Array;
}
export interface DecryptKey {
  keyId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** Short stable id for a public key: first 16 hex chars of sha256(publicKey). */
export function keyId(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new CryptoError('BAD_INPUT', 'public key must be 32 bytes');
  return toHex(s().crypto_hash_sha256(publicKey).subarray(0, KEYID_BYTES));
}

function assertKeyId(id: string): void {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new CryptoError('BAD_INPUT', 'keyId must be 16 lowercase hex chars');
}

function associatedData(sortedKeyIds: string[]): Uint8Array {
  return concat(AD_PREFIX, utf8(sortedKeyIds.join(',')));
}

function serializePlain(p: PlainEmail): Uint8Array {
  const subject = utf8(p.subject);
  const body = utf8(p.body);
  const eml = p.rawEml;
  if (p.meta !== undefined && (p.meta === null || typeof p.meta !== 'object' || Array.isArray(p.meta))) {
    throw new CryptoError('BAD_INPUT', 'meta must be a JSON object');
  }
  const meta = p.meta !== undefined ? utf8(JSON.stringify(p.meta)) : undefined;
  const out = concat(
    Uint8Array.of(ENVELOPE_VERSION, (eml ? FLAG_RAW_EML : 0) | (meta ? FLAG_META : 0)),
    u32be(subject.length),
    subject,
    u32be(body.length),
    body,
    ...(eml ? [u32be(eml.length), eml] : []),
    ...(meta ? [u32be(meta.length), meta] : []),
  );
  s().memzero(subject);
  s().memzero(body);
  if (meta) s().memzero(meta);
  return out;
}

function parsePlain(buf: Uint8Array): DecryptedEmail {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const need = (n: number) => {
    if (o + n > buf.length) throw new CryptoError('BAD_FORMAT', 'truncated plaintext');
  };
  need(2);
  if (buf[0] !== ENVELOPE_VERSION) throw new CryptoError('UNSUPPORTED_VERSION', 'unknown plaintext version');
  const flags = buf[1] as number;
  if (flags & ~KNOWN_FLAGS) throw new CryptoError('BAD_FORMAT', 'unknown plaintext flags');
  o = 2;
  const field = (): Uint8Array => {
    need(4);
    const len = dv.getUint32(o, false);
    o += 4;
    need(len);
    const f = buf.slice(o, o + len);
    o += len;
    return f;
  };
  const dec = new TextDecoder('utf-8', { fatal: true });
  const subjB = field();
  const bodyB = field();
  const rawEml = flags & FLAG_RAW_EML ? field() : undefined;
  const metaB = flags & FLAG_META ? field() : undefined;
  if (o !== buf.length) throw new CryptoError('BAD_FORMAT', 'trailing bytes');
  try {
    let meta: EmailMeta | undefined;
    if (metaB) {
      const parsed: unknown = JSON.parse(dec.decode(metaB));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('meta');
      meta = parsed as EmailMeta;
    }
    return {
      subject: dec.decode(subjB),
      body: dec.decode(bodyB),
      ...(rawEml ? { rawEml } : {}),
      ...(meta ? { meta } : {}),
    };
  } catch {
    throw new CryptoError('BAD_FORMAT', 'invalid utf-8 or meta');
  } finally {
    s().memzero(subjB);
    s().memzero(bodyB);
    if (metaB) s().memzero(metaB);
  }
}

/** Parse wrappedKeys into slots. */
export function parseWrappedKeys(wk: Uint8Array): { keyId: string; sealed: Uint8Array }[] {
  if (wk.length < 2) throw new CryptoError('BAD_FORMAT', 'wrappedKeys too short');
  if (wk[0] !== WRAPPED_KEYS_VERSION) throw new CryptoError('UNSUPPORTED_VERSION', 'unknown wrappedKeys version');
  const count = wk[1] as number;
  if (count === 0 || wk.length !== 2 + count * SLOT_BYTES) throw new CryptoError('BAD_FORMAT', 'wrappedKeys length mismatch');
  const slots: { keyId: string; sealed: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    const base = 2 + i * SLOT_BYTES;
    slots.push({
      keyId: toHex(wk.subarray(base, base + KEYID_BYTES)),
      sealed: wk.subarray(base + KEYID_BYTES, base + SLOT_BYTES),
    });
  }
  return slots;
}

export async function encryptEmail(plain: PlainEmail, recipients: Recipient[]): Promise<EncryptedEmail> {
  await ready();
  const sd = s();
  if (recipients.length < 1 || recipients.length > 255) throw new CryptoError('BAD_INPUT', 'need 1..255 recipients');
  const seen = new Set<string>();
  for (const r of recipients) {
    assertKeyId(r.keyId);
    if (r.publicKey.length !== sd.crypto_box_PUBLICKEYBYTES) throw new CryptoError('BAD_INPUT', 'bad recipient public key');
    if (keyId(r.publicKey) !== r.keyId) throw new CryptoError('BAD_INPUT', 'keyId does not match publicKey');
    if (seen.has(r.keyId)) throw new CryptoError('BAD_INPUT', 'duplicate recipient');
    seen.add(r.keyId);
  }
  const sorted = [...recipients].sort((a, b) => (a.keyId < b.keyId ? -1 : 1));
  const keyIds = sorted.map((r) => r.keyId);

  const contentKey = sd.randombytes_buf(sd.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  const nonce = randomBytes(sd.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const serialized = serializePlain(plain);
  try {
    const aead = sd.crypto_aead_xchacha20poly1305_ietf_encrypt(serialized, associatedData(keyIds), null, nonce, contentKey);
    const ciphertext = concat(Uint8Array.of(ENVELOPE_VERSION), aead);
    const slots = sorted.map((r) => concat(sd.from_hex(r.keyId), sd.crypto_box_seal(contentKey, r.publicKey)));
    const wrappedKeys = concat(Uint8Array.of(WRAPPED_KEYS_VERSION, slots.length), ...slots);
    return { ciphertext, nonce, wrappedKeys, keyIds };
  } finally {
    sd.memzero(contentKey);
    sd.memzero(serialized);
  }
}

export async function decryptEmail(
  entity: EmailEntityBytes,
  key: DecryptKey,
): Promise<DecryptedEmail> {
  await ready();
  const sd = s();
  const { ciphertext, nonce, wrappedKeys } = entity;
  if (ciphertext.length < 1 + sd.crypto_aead_xchacha20poly1305_ietf_ABYTES) throw new CryptoError('BAD_FORMAT', 'ciphertext too short');
  if (ciphertext[0] !== ENVELOPE_VERSION) throw new CryptoError('UNSUPPORTED_VERSION', 'unknown envelope version');
  if (nonce.length !== sd.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES) throw new CryptoError('BAD_FORMAT', 'bad nonce length');
  const slots = parseWrappedKeys(wrappedKeys);
  const slot = slots.find((x) => x.keyId === key.keyId);
  if (!slot) throw new CryptoError('NO_SLOT', 'no wrapped key for this keyId');
  let contentKey: Uint8Array;
  try {
    contentKey = sd.crypto_box_seal_open(slot.sealed, key.publicKey, key.privateKey);
  } catch {
    throw new CryptoError('WRONG_KEY', 'could not unseal content key with the given key');
  }
  let serialized: Uint8Array | undefined;
  try {
    // slot keyIds are already in sorted order as written; re-sort defensively for AD equality
    const ad = associatedData(slots.map((x) => x.keyId).sort());
    try {
      serialized = sd.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext.subarray(1), ad, nonce, contentKey);
    } catch {
      throw new CryptoError('TAMPERED', 'authentication failed (ciphertext, nonce or slots modified)');
    }
    return parsePlain(serialized);
  } finally {
    sd.memzero(contentKey);
    if (serialized) sd.memzero(serialized);
  }
}
