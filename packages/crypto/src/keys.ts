// User keys, wrapping keys (signature / recovery code / passphrase) and wrapped-secret blobs.
import { CryptoError, concat, fromHex, hkdfSha256, ready, randomBytes, s, utf8 } from './core';

export interface Keypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * The message the wallet signs to derive the key-wrapping key. It is never used for login
 * (the login message differs), so a phishing site that gets a login signature cannot derive keys.
 * Do NOT edit: changing a single byte changes every user's wrapping key.
 */
export const KEY_DERIVATION_MESSAGE =
  'Nanite key derivation v1\n' +
  'Domain: nanite.email\n' +
  'Purpose: unlock your Nanite mailbox encryption key.\n' +
  'Only sign this on nanite.email. This is NOT a login and costs no gas.';

export const SALT_BYTES = 16; // crypto_pwhash_SALTBYTES

/** Argon2id parameters (libsodium crypto_pwhash, ALG_ARGON2ID13). See README for rationale. */
export const ARGON2_RECOVERY = { opslimit: 2, memlimit: 64 * 1024 * 1024 } as const;
export const ARGON2_PASSPHRASE = { opslimit: 4, memlimit: 128 * 1024 * 1024 } as const;

const WRAPPED_SECRET_VERSION = 1;

export async function generateUserKeypair(): Promise<Keypair> {
  await ready();
  const kp = s().crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/** Fresh random salt (16 bytes). Store it next to the wrapped blob; it is not secret. */
export async function generateSalt(): Promise<Uint8Array> {
  await ready();
  return randomBytes(SALT_BYTES);
}

/**
 * Wrapping key from a wallet signature: HKDF-SHA256(ikm = signature bytes, salt, info = "nanite/wrap/signature/v1"), 32 bytes.
 * HKDF is implemented over libsodium's SHA-256 (see core.ts, RFC 5869 vector tested).
 * Requires a deterministic signature (RFC 6979 EOAs); use signaturesAreDeterministic() at setup.
 */
export async function deriveWrappingKeyFromSignature(signatureHex: string, salt: Uint8Array): Promise<Uint8Array> {
  await ready();
  const sig = fromHex(signatureHex);
  if (sig.length < 64) throw new CryptoError('BAD_INPUT', 'signature too short');
  try {
    return hkdfSha256(sig, salt, utf8('nanite/wrap/signature/v1'), 32);
  } finally {
    s().memzero(sig);
  }
}

/** Setup helper: sign KEY_DERIVATION_MESSAGE twice; if the results differ, fall back to a passphrase. */
export function signaturesAreDeterministic(sigA: string, sigB: string): boolean {
  const a = sigA.trim().toLowerCase();
  const b = sigB.trim().toLowerCase();
  return a.length > 0 && a === b;
}

/** Blob = version(1) || nonce(24) || XChaCha20-Poly1305-IETF(secret; ad = version byte). */
export async function wrapSecret(secret: Uint8Array, wrappingKey: Uint8Array): Promise<Uint8Array> {
  await ready();
  const sd = s();
  if (wrappingKey.length !== 32) throw new CryptoError('BAD_INPUT', 'wrapping key must be 32 bytes');
  const version = Uint8Array.of(WRAPPED_SECRET_VERSION);
  const nonce = randomBytes(sd.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sd.crypto_aead_xchacha20poly1305_ietf_encrypt(secret, version, null, nonce, wrappingKey);
  return concat(version, nonce, ct);
}

export async function unwrapSecret(blob: Uint8Array, wrappingKey: Uint8Array): Promise<Uint8Array> {
  await ready();
  const sd = s();
  const N = sd.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (blob.length < 1 + N + sd.crypto_aead_xchacha20poly1305_ietf_ABYTES) throw new CryptoError('BAD_FORMAT', 'blob too short');
  if (blob[0] !== WRAPPED_SECRET_VERSION) throw new CryptoError('UNSUPPORTED_VERSION', 'unknown wrapped-secret version');
  if (wrappingKey.length !== 32) throw new CryptoError('BAD_INPUT', 'wrapping key must be 32 bytes');
  try {
    return sd.crypto_aead_xchacha20poly1305_ietf_decrypt(null, blob.subarray(1 + N), blob.subarray(0, 1), blob.subarray(1, 1 + N), wrappingKey);
  } catch {
    throw new CryptoError('WRONG_KEY', 'wrong wrapping key or corrupted blob');
  }
}

function argon2id(password: Uint8Array, salt: Uint8Array, p: { opslimit: number; memlimit: number }): Uint8Array {
  const sd = s();
  if (salt.length !== SALT_BYTES) throw new CryptoError('BAD_INPUT', 'salt must be 16 bytes');
  return sd.crypto_pwhash(32, password, salt, p.opslimit, p.memlimit, sd.crypto_pwhash_ALG_ARGON2ID13);
}

// Crockford base32 (no I, L, O, U): 5 bits/char.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_CHARS = 25; // 125 bits
const GROUP = 5;

/** 25 Crockford-base32 chars (125 bits of entropy) as 5 groups: "ABCDE-FGHJK-...". Show once. */
export async function generateRecoveryCode(): Promise<string> {
  await ready();
  const sd = s();
  let out = '';
  for (let i = 0; i < RECOVERY_CHARS; i++) {
    if (i > 0 && i % GROUP === 0) out += '-';
    out += ALPHABET[sd.randombytes_uniform(32)];
  }
  return out;
}

/** Uppercase, drop spaces/dashes/other separators, Crockford aliases (O->0, I/L->1). */
export function normalizeRecoveryCode(code: string): string {
  const n = code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (n.length !== RECOVERY_CHARS || [...n].some((c) => !ALPHABET.includes(c))) {
    throw new CryptoError('BAD_INPUT', 'invalid recovery code');
  }
  return n;
}

export async function deriveWrappingKeyFromRecoveryCode(code: string, salt: Uint8Array): Promise<Uint8Array> {
  await ready();
  const pw = utf8('nanite/recovery/v1|' + normalizeRecoveryCode(code));
  try {
    return argon2id(pw, salt, ARGON2_RECOVERY);
  } finally {
    s().memzero(pw);
  }
}

export async function deriveWrappingKeyFromPassphrase(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  await ready();
  if (passphrase.length === 0) throw new CryptoError('BAD_INPUT', 'empty passphrase');
  const pw = utf8('nanite/passphrase/v1|' + passphrase.normalize('NFKC'));
  try {
    return argon2id(pw, salt, ARGON2_PASSPHRASE);
  } finally {
    s().memzero(pw);
  }
}
