/*
 * Custody = nanite: the agent's X25519 private key is stored in agents.encrypted_private_key,
 * wrapped with @nanite/crypto wrapSecret under a per-agent key derived from NANITE_MASTER_KEY
 * (HKDF-SHA256, info bound to the agent id, so a blob copied to another agent row does not unseal).
 * The master key and plaintext private keys are never logged or stored.
 */
import { generateUserKeypair, hkdfSha256, keyId, ready, unwrapSecret, wrapSecret } from "@nanite/crypto";
import { setAgentNaniteKey, type Db } from "@nanite/db";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";

const enc = new TextEncoder();

/** Parse NANITE_MASTER_KEY: 32 bytes as 64 hex chars or base64/base64url. Errors never echo the value. */
export function parseMasterKey(value: string): Uint8Array {
  const v = value.trim();
  let bytes: Uint8Array | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(v)) {
    bytes = new Uint8Array(Buffer.from(v, "hex"));
  } else if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 32) bytes = new Uint8Array(b);
  }
  if (!bytes) throw new Error("NANITE_MASTER_KEY must be 32 bytes as 64 hex characters or base64");
  if (bytes.every((b) => b === 0)) throw new Error("NANITE_MASTER_KEY must not be all zeros");
  return bytes;
}

async function wrappingKey(master: Uint8Array, agentId: string, purpose = "nanite/agent-key/v1"): Promise<Uint8Array> {
  await ready();
  return hkdfSha256(master, new Uint8Array(0), enc.encode(`${purpose}|${agentId}`), 32);
}

/*
 * Mail-signing key (signing option B): a secp256k1 key per agent that only signs outgoing mail. Sealed like the
 * encryption key, but under its own HKDF label, so a blob copied between the two columns never unseals.
 */
const SIGNER_PURPOSE = "nanite/agent-signer-key/v1";

export async function sealAgentSignerKey(master: Uint8Array, agentId: string, privateKey: Uint8Array) {
  return wrapSecret(privateKey, await wrappingKey(master, agentId, SIGNER_PURPOSE));
}

/** Throws CryptoError (WRONG_KEY) for a wrong master key, wrong agent or corrupted blob. */
export async function unsealAgentSignerKey(master: Uint8Array, agentId: string, blob: Uint8Array) {
  return unwrapSecret(blob, await wrappingKey(master, agentId, SIGNER_PURPOSE));
}

/** A fresh signer key, sealed for `agentId`. The caller keeps only the address and the sealed blob. */
export async function generateSealedSigner(master: Uint8Array, agentId: string) {
  const key = generatePrivateKey();
  const bytes = new Uint8Array(Buffer.from(key.slice(2), "hex"));
  try {
    return { address: privateKeyToAddress(key), sealed: await sealAgentSignerKey(master, agentId, bytes) };
  } finally {
    bytes.fill(0);
  }
}

/** Sign `message` (EIP-191) with the agent's sealed signer key. The key lives in memory for this call only. */
export async function signWithSealedSigner(master: Uint8Array, agentId: string, blob: Uint8Array, message: string) {
  const bytes = await unsealAgentSignerKey(master, agentId, blob);
  try {
    const account = privateKeyToAccount(`0x${Buffer.from(bytes).toString("hex")}`);
    return { signature: await account.signMessage({ message }), address: account.address };
  } finally {
    bytes.fill(0);
  }
}

export async function sealAgentPrivateKey(master: Uint8Array, agentId: string, privateKey: Uint8Array) {
  return wrapSecret(privateKey, await wrappingKey(master, agentId));
}

/** Throws CryptoError (WRONG_KEY) for a wrong master key, wrong agent or corrupted blob. */
export async function unsealAgentPrivateKey(master: Uint8Array, agentId: string, blob: Uint8Array) {
  return unwrapSecret(blob, await wrappingKey(master, agentId));
}

/** Generate a fresh keypair for an agent, store public key + sealed private key, custody = nanite. */
export async function provisionNaniteAgentKey(db: Db, agentId: string, master: Uint8Array) {
  const kp = await generateUserKeypair();
  const sealed = await sealAgentPrivateKey(master, agentId, kp.privateKey);
  const id = keyId(kp.publicKey);
  await setAgentNaniteKey(db, agentId, { publicKey: kp.publicKey, keyId: id, encryptedPrivateKey: sealed });
  return { keyId: id, publicKey: kp.publicKey };
}
