export { CryptoError, ready, hkdfSha256, hmacSha256, toHex, fromHex } from './core';
export type { CryptoErrorCode } from './core';
export {
  encryptEmail,
  decryptEmail,
  keyId,
  parseWrappedKeys,
  ENVELOPE_VERSION,
  WRAPPED_KEYS_VERSION,
} from './envelope';
export type { PlainEmail, DecryptedEmail, EmailMeta, Recipient, EncryptedEmail, EmailEntityBytes, DecryptKey } from './envelope';
export {
  KEY_DERIVATION_MESSAGE,
  SALT_BYTES,
  ARGON2_RECOVERY,
  ARGON2_PASSPHRASE,
  generateUserKeypair,
  generateSalt,
  deriveWrappingKeyFromSignature,
  signaturesAreDeterministic,
  wrapSecret,
  unwrapSecret,
  generateRecoveryCode,
  normalizeRecoveryCode,
  deriveWrappingKeyFromRecoveryCode,
  deriveWrappingKeyFromPassphrase,
} from './keys';
export type { Keypair } from './keys';
export { probeDeterministicSignature, prepareKeys, unlockWithBundle } from './onboarding';
export type { KeyBundle, PreparedKeys, Signer, UnlockedKeys, UnlockSecret, Wrapping } from './onboarding';
export { htmlToText, extractLinks, classify, buildThreadLinks, MSGID_RE, MAX_REFERENCES, MAX_REFERENCES_CHARS } from './extract';
export type { Classification, ThreadLinks } from './extract';
export { SIG_VERSION, SIG_VERSION_V2, canonicalSendStringV2, canonicalSendStringV3 } from './sendsig';
export type { CanonicalFields, CanonicalFieldsV3 } from './sendsig';
export { generateNaniteSeed, deriveAgentWallet, deriveAgentEncryptionKeypair, senderHash } from './agent';
