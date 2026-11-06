/*
 * The self-hosted agent key file: an X25519 encryption keypair (decrypts the agent's mail) and a secp256k1 signer key
 * (signs outbound mail), both generated on the agent's machine. Only the public values ever leave it.
 *
 * Plain file: JSON, mode 600 (the directory is 700). Optional passphrase: the two private keys are sealed with a key
 * derived by Argon2id (@nanite/crypto), so a copied file is useless without the passphrase.
 * Nothing in this module prints or logs a private key.
 */
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CryptoError,
  deriveWrappingKeyFromPassphrase,
  generateSalt,
  generateUserKeypair,
  keyId as computeKeyId,
  unwrapSecret,
  wrapSecret,
} from "@nanite/crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const DEFAULT_KEY_DIR = join(homedir(), ".nanite");
export const KEY_FILE_NAME = "agent-key.json";
const FILE_VERSION = 1;

export interface LocalKey {
  /** keyId of the encryption public key (first 16 hex of its sha256), as stored on the server. */
  keyId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  /** secp256k1 private key (0x hex) for signing outbound mail. */
  signerPrivateKey: `0x${string}`;
  signerAddress: `0x${string}`;
}

/** What `keygen` may show: public values only. */
export interface PublicKeyInfo {
  /** Base64 of the 32-byte X25519 public key: the value POST /agents expects as `encryptionPublicKey`. */
  encryptionPublicKey: string;
  keyId: string;
  signerAddress: `0x${string}`;
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const enc = new TextEncoder();
const dec = new TextDecoder();

export function defaultKeyFilePath(): string {
  return join(DEFAULT_KEY_DIR, KEY_FILE_NAME);
}

/** Serialize and write a key file with mode 600 (directory 700). */
async function writeKeyFile(
  path: string,
  key: { publicKey: Uint8Array; privateKey: Uint8Array; signerPrivateKey: `0x${string}` },
  opts: { passphrase?: string | undefined; overwrite: boolean },
): Promise<PublicKeyInfo> {
  const signerAddress = privateKeyToAccount(key.signerPrivateKey as `0x${string}`).address;
  const info: PublicKeyInfo = { encryptionPublicKey: b64(key.publicKey), keyId: computeKeyId(key.publicKey), signerAddress };
  const secrets = { encryptionPrivateKey: b64(key.privateKey), signerPrivateKey: key.signerPrivateKey };
  let file: Record<string, unknown>;
  if (opts.passphrase) {
    const salt = await generateSalt();
    const wrappingKey = await deriveWrappingKeyFromPassphrase(opts.passphrase, salt);
    const wrapped = await wrapSecret(enc.encode(JSON.stringify(secrets)), wrappingKey);
    wrappingKey.fill(0);
    file = { version: FILE_VERSION, encrypted: true, kdf: "argon2id", salt: b64(salt), wrapped: b64(wrapped), ...info };
  } else {
    file = { version: FILE_VERSION, encrypted: false, ...info, ...secrets };
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ ...file, createdAt: new Date().toISOString() }, null, 2) + "\n", {
    mode: 0o600,
    flag: opts.overwrite ? "w" : "wx",
  });
  await chmod(path, 0o600); // writeFile's mode is masked by the umask and ignored for an existing file
  return info;
}

/** Generate both keys and write the key file (refuses to overwrite unless `force`). Returns the public values only. */
export async function generateKeyFile(opts: { path: string; passphrase?: string | undefined; force?: boolean }): Promise<PublicKeyInfo> {
  const kp = await generateUserKeypair();
  try {
    return await writeKeyFile(opts.path, { ...kp, signerPrivateKey: generatePrivateKey() }, { passphrase: opts.passphrase, overwrite: !!opts.force });
  } finally {
    kp.privateKey.fill(0);
  }
}

/**
 * Replace ONLY the signer key in an existing key file (the encryption key is kept, so old mail stays readable).
 * Keeps the passphrase protection if the file has it. Returns the public values (the new signer address).
 */
export async function rotateSignerKey(path: string, passphrase?: string): Promise<PublicKeyInfo> {
  const key = await loadKeyFile(path, passphrase);
  try {
    return await writeKeyFile(path, { ...key, signerPrivateKey: generatePrivateKey() }, { passphrase, overwrite: true });
  } finally {
    key.privateKey.fill(0);
  }
}

/** Load and validate a key file. Throws with a fixed message that never contains key material. */
export async function loadKeyFile(path: string, passphrase?: string): Promise<LocalKey> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error("cannot read the agent key file (NANITE_AGENT_KEY_FILE)");
  }
  if (process.platform !== "win32") {
    const mode = (await stat(path)).mode & 0o777;
    if (mode & 0o077) console.error(`nanite-mcp: warning: the key file is readable by other users (mode ${mode.toString(8)}); run: chmod 600 <key file>`);
  }
  let f: Record<string, unknown>;
  try {
    f = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("the agent key file is not valid JSON");
  }
  if (f.version !== FILE_VERSION) throw new Error("unsupported agent key file version");
  let encryptionPrivateKey: unknown;
  let signerPrivateKey: unknown;
  if (f.encrypted === true) {
    if (!passphrase) throw new Error("the agent key file is passphrase-protected: set NANITE_AGENT_KEY_PASSPHRASE");
    try {
      const wk = await deriveWrappingKeyFromPassphrase(passphrase, unb64(String(f.salt)));
      const plain = await unwrapSecret(unb64(String(f.wrapped)), wk);
      wk.fill(0);
      ({ encryptionPrivateKey, signerPrivateKey } = JSON.parse(dec.decode(plain)) as Record<string, unknown>);
    } catch (e) {
      throw new Error(e instanceof CryptoError ? "wrong passphrase for the agent key file" : "the agent key file is corrupted");
    }
  } else {
    ({ encryptionPrivateKey, signerPrivateKey } = f);
  }
  if (typeof f.encryptionPublicKey !== "string" || typeof encryptionPrivateKey !== "string" || typeof signerPrivateKey !== "string") {
    throw new Error("the agent key file is incomplete");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(signerPrivateKey)) throw new Error("the agent key file has an invalid signer key");
  const publicKey = unb64(f.encryptionPublicKey);
  const privateKey = unb64(encryptionPrivateKey);
  if (publicKey.length !== 32 || privateKey.length !== 32) throw new Error("the agent key file has an invalid encryption key");
  const signerAddress = privateKeyToAccount(signerPrivateKey as `0x${string}`).address;
  if (typeof f.signerAddress === "string" && f.signerAddress.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error("the agent key file is inconsistent (signer address mismatch)");
  }
  return { keyId: computeKeyId(publicKey), publicKey, privateKey, signerPrivateKey: signerPrivateKey as `0x${string}`, signerAddress };
}
