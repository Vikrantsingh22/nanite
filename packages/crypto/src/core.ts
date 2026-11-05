// Shared plumbing: libsodium init, typed errors, byte helpers, HMAC/HKDF.
// No node:* imports anywhere in this package.
import sodium from 'libsodium-wrappers-sumo';

export type CryptoErrorCode =
  | 'BAD_FORMAT'
  | 'UNSUPPORTED_VERSION'
  | 'NO_SLOT'
  | 'WRONG_KEY'
  | 'TAMPERED'
  | 'BAD_INPUT';

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}

let readyPromise: Promise<void> | undefined;

/** Resolves once libsodium (WASM) is initialised. Safe to call many times. */
export function ready(): Promise<void> {
  readyPromise ??= sodium.ready;
  return readyPromise;
}

/** Internal: the initialised sodium instance. Throws if ready() was not awaited. */
export function s(): typeof sodium {
  if (!readyPromise) throw new CryptoError('BAD_INPUT', 'call await ready() before using @nanite/crypto');
  return sodium;
}

const enc = new TextEncoder();
// Re-wrap so the result is an instance of this realm's Uint8Array (jsdom/iframes can return a
// foreign-realm array from TextEncoder, which libsodium rejects).
export const utf8 = (str: string): Uint8Array => new Uint8Array(enc.encode(str));

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  return s().to_hex(b);
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new CryptoError('BAD_INPUT', 'invalid hex string');
  }
  return s().from_hex(clean);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && s().memcmp(a, b);
}

export function randomBytes(n: number): Uint8Array {
  return s().randombytes_buf(n);
}

const SHA256_BLOCK = 64;

/** HMAC-SHA256 (RFC 2104) built on crypto_hash_sha256, so any key length works. */
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const sd = s();
  let k = key;
  if (k.length > SHA256_BLOCK) k = sd.crypto_hash_sha256(k);
  const ipad = new Uint8Array(SHA256_BLOCK).fill(0x36);
  const opad = new Uint8Array(SHA256_BLOCK).fill(0x5c);
  for (let i = 0; i < k.length; i++) {
    ipad[i] = (ipad[i] as number) ^ (k[i] as number);
    opad[i] = (opad[i] as number) ^ (k[i] as number);
  }
  const inner = sd.crypto_hash_sha256(concat(ipad, msg));
  const out = sd.crypto_hash_sha256(concat(opad, inner));
  sd.memzero(ipad);
  sd.memzero(opad);
  return out;
}

/** HKDF-SHA256 (RFC 5869). Empty salt = 32 zero bytes (per RFC). length <= 255*32. */
export function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  if (length < 1 || length > 255 * 32) throw new CryptoError('BAD_INPUT', 'invalid HKDF length');
  const prk = hmacSha256(salt.length ? salt : new Uint8Array(32), ikm);
  const out = new Uint8Array(length);
  let t: Uint8Array = new Uint8Array(0);
  let pos = 0;
  for (let i = 1; pos < length; i++) {
    t = hmacSha256(prk, concat(t, info, Uint8Array.of(i)));
    const take = Math.min(t.length, length - pos);
    out.set(t.subarray(0, take), pos);
    pos += take;
  }
  s().memzero(prk);
  return out;
}

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}
