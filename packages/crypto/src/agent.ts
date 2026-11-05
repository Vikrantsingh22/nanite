// Nanite seed, per-agent wallet / encryption key derivation, blind index.
import { HDKey } from '@scure/bip32';
import { privateKeyToAddress } from 'viem/accounts';
import { CryptoError, hkdfSha256, hmacSha256, randomBytes, ready, s, toHex, utf8 } from './core';
import type { Keypair } from './keys';

/**
 * Seed choice: 32 random bytes (256-bit), used directly as the BIP-32 master seed.
 * Not a BIP-39 mnemonic: nothing here is meant to be typed by a human, and a mnemonic would add
 * a wordlist dependency and tempt people to import it into a normal wallet. Back it up as hex/base64.
 */
export async function generateNaniteSeed(): Promise<Uint8Array> {
  await ready();
  return randomBytes(32);
}

function checkSeed(seed: Uint8Array): void {
  if (seed.length < 16 || seed.length > 64) throw new CryptoError('BAD_INPUT', 'seed must be 16..64 bytes');
}
function checkIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new CryptoError('BAD_INPUT', 'invalid agent index');
}

/** Agent wallet at m/44'/60'/0'/0/<index> (secp256k1). privateKey is a 0x-hex string (viem style). */
export async function deriveAgentWallet(seed: Uint8Array, index: number): Promise<{ address: `0x${string}`; privateKey: `0x${string}` }> {
  await ready();
  checkSeed(seed);
  checkIndex(index);
  const child = HDKey.fromMasterSeed(seed).derive(`m/44'/60'/0'/0/${index}`);
  if (!child.privateKey) throw new CryptoError('BAD_INPUT', 'derivation failed');
  const privateKey = `0x${toHex(child.privateKey)}` as const;
  return { address: privateKeyToAddress(privateKey), privateKey };
}

/**
 * Agent X25519 keypair = scalarmult_base(HKDF-SHA256(ikm = seed, salt = empty, info = "nanite/agent-encryption/v1/<index>")).
 * Independent of the wallet key (different KDF, domain-separated info; no shared intermediate).
 */
export async function deriveAgentEncryptionKeypair(seed: Uint8Array, index: number): Promise<Keypair> {
  await ready();
  checkSeed(seed);
  checkIndex(index);
  const sk = hkdfSha256(seed, new Uint8Array(0), utf8(`nanite/agent-encryption/v1/${index}`), 32);
  return { publicKey: s().crypto_scalarmult_base(sk), privateKey: sk };
}

function normalizeAddress(addr: string): string {
  let a = addr.trim();
  const m = /<([^<>]+)>\s*$/.exec(a); // "Name <a@b.c>" -> a@b.c
  if (m?.[1]) a = m[1];
  return a.trim().toLowerCase();
}

/**
 * Blind index for the plaintext senderHash column: hex(HMAC-SHA256(userKey, normalizedAddress)),
 * userKey = HMAC-SHA256(serverSecret, "nanite/sender-hash/v1/user/" + userId). 64 hex chars.
 * Per-user keys mean the same sender gets different hashes for different users.
 */
export async function senderHash(secret: string | Uint8Array, userId: string, senderAddress: string): Promise<string> {
  await ready();
  const sec = typeof secret === 'string' ? utf8(secret) : secret;
  if (sec.length < 16) throw new CryptoError('BAD_INPUT', 'sender-hash secret too short');
  if (!userId) throw new CryptoError('BAD_INPUT', 'userId required');
  const userKey = hmacSha256(sec, utf8('nanite/sender-hash/v1/user/' + userId));
  try {
    return toHex(hmacSha256(userKey, utf8(normalizeAddress(senderAddress))));
  } finally {
    s().memzero(userKey);
  }
}
