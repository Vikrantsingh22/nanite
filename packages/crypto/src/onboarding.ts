// Browser-side key setup and unlock, shared by the web app and the live scripts (they run the very same code).
import {
  KEY_DERIVATION_MESSAGE,
  deriveWrappingKeyFromPassphrase,
  deriveWrappingKeyFromRecoveryCode,
  deriveWrappingKeyFromSignature,
  generateRecoveryCode,
  generateSalt,
  generateUserKeypair,
  signaturesAreDeterministic,
  unwrapSecret,
  wrapSecret,
} from './keys';
import { generateNaniteSeed } from './agent';
import { keyId } from './envelope';

/*
 * Everything secret stays in memory. Only the public key, key id, salts and wrapped blobs
 * (KeyBundle) are ever sent to the server. The signatures, passphrase, recovery code, private
 * key and seed never leave memory and are never written to any storage.
 */

/** What POST /onboarding/keys receives and GET /onboarding/keys returns (all binary as standard base64). */
export interface KeyBundle {
  publicKey: string;
  keyId: string;
  walletSalt: string;
  recoverySalt: string;
  wrappedPrivateKeyWallet: string;
  wrappedPrivateKeyRecovery: string;
  wrappedSeedWallet: string;
  wrappedSeedRecovery: string;
  passphraseMode: boolean;
}

export type Signer = (message: string) => Promise<string>;

export interface UnlockedKeys {
  privateKey: Uint8Array;
  seed: Uint8Array;
  publicKey: Uint8Array;
  keyId: string;
}

export type Wrapping = { kind: 'signature'; signature: string } | { kind: 'passphrase'; passphrase: string };

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Signs KEY_DERIVATION_MESSAGE twice. Deterministic wallets (RFC 6979 EOAs) can use the signature path. */
export async function probeDeterministicSignature(sign: Signer): Promise<{ deterministic: boolean; signature: string }> {
  const a = await sign(KEY_DERIVATION_MESSAGE);
  const b = await sign(KEY_DERIVATION_MESSAGE);
  return { deterministic: signaturesAreDeterministic(a, b), signature: a };
}

export interface PreparedKeys {
  /** Public data only: this is what POST /onboarding/keys receives. */
  bundle: KeyBundle;
  /** Show once. */
  recoveryCode: string;
  unlocked: UnlockedKeys;
}

export async function prepareKeys(wrapping: Wrapping): Promise<PreparedKeys> {
  const kp = await generateUserKeypair();
  const seed = await generateNaniteSeed();
  const walletSalt = await generateSalt();
  const recoverySalt = await generateSalt();
  const recoveryCode = await generateRecoveryCode();

  const primary =
    wrapping.kind === 'signature'
      ? await deriveWrappingKeyFromSignature(wrapping.signature, walletSalt)
      : await deriveWrappingKeyFromPassphrase(wrapping.passphrase, walletSalt);
  const recovery = await deriveWrappingKeyFromRecoveryCode(recoveryCode, recoverySalt);

  const bundle: KeyBundle = {
    publicKey: b64(kp.publicKey),
    keyId: keyId(kp.publicKey),
    walletSalt: b64(walletSalt),
    recoverySalt: b64(recoverySalt),
    wrappedPrivateKeyWallet: b64(await wrapSecret(kp.privateKey, primary)),
    wrappedPrivateKeyRecovery: b64(await wrapSecret(kp.privateKey, recovery)),
    wrappedSeedWallet: b64(await wrapSecret(seed, primary)),
    wrappedSeedRecovery: b64(await wrapSecret(seed, recovery)),
    passphraseMode: wrapping.kind === 'passphrase',
  };
  primary.fill(0);
  recovery.fill(0);
  return { bundle, recoveryCode, unlocked: { privateKey: kp.privateKey, seed, publicKey: kp.publicKey, keyId: bundle.keyId } };
}

export type UnlockSecret =
  | { kind: 'signature'; signature: string }
  | { kind: 'passphrase'; passphrase: string }
  | { kind: 'recovery'; code: string };

/** Unwraps the private key and seed from the server-stored bundle using the wallet/passphrase/recovery key. */
export async function unlockWithBundle(
  stored: KeyBundle & { keyVersion?: number },
  secret: UnlockSecret,
): Promise<UnlockedKeys> {
  let wrappingKey: Uint8Array;
  let wrappedKey: string;
  let wrappedSeed: string;
  if (secret.kind === 'recovery') {
    wrappingKey = await deriveWrappingKeyFromRecoveryCode(secret.code, unb64(stored.recoverySalt));
    wrappedKey = stored.wrappedPrivateKeyRecovery;
    wrappedSeed = stored.wrappedSeedRecovery;
  } else {
    wrappingKey =
      secret.kind === 'signature'
        ? await deriveWrappingKeyFromSignature(secret.signature, unb64(stored.walletSalt))
        : await deriveWrappingKeyFromPassphrase(secret.passphrase, unb64(stored.walletSalt));
    wrappedKey = stored.wrappedPrivateKeyWallet;
    wrappedSeed = stored.wrappedSeedWallet;
  }
  try {
    const privateKey = await unwrapSecret(unb64(wrappedKey), wrappingKey);
    const seed = await unwrapSecret(unb64(wrappedSeed), wrappingKey);
    return { privateKey, seed, publicKey: unb64(stored.publicKey), keyId: stored.keyId };
  } finally {
    wrappingKey.fill(0);
  }
}
