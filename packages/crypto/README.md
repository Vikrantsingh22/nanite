# @nanite/crypto

Shared crypto for browser and server (T1.2). ESM, TypeScript strict, no `node:*` imports in `src/`.
Call `await ready()` (or any async API, which awaits it) before use.

Dependencies (pinned): `libsodium-wrappers-sumo` 0.8.4 (sumo build is needed for Argon2id), `@scure/bip32` 2.2.0 (BIP-32), `viem` 2.21.54 (address from key only).

## API

| Area | Functions |
| --- | --- |
| Envelope | `encryptEmail(plain, recipients)`, `decryptEmail(entity, {keyId, publicKey, privateKey})`, `keyId(publicKey)`, `parseWrappedKeys` |
| User keys | `generateUserKeypair()`, `generateSalt()`, `KEY_DERIVATION_MESSAGE`, `deriveWrappingKeyFromSignature(sigHex, salt)`, `signaturesAreDeterministic(a, b)`, `wrapSecret`, `unwrapSecret` |
| Recovery / fallback | `generateRecoveryCode()`, `normalizeRecoveryCode`, `deriveWrappingKeyFromRecoveryCode(code, salt)`, `deriveWrappingKeyFromPassphrase(pass, salt)` |
| Agents | `generateNaniteSeed()`, `deriveAgentWallet(seed, i)`, `deriveAgentEncryptionKeypair(seed, i)` |
| Server index | `senderHash(secret, userId, address)` |
| Errors | `CryptoError` with `code`: `BAD_FORMAT`, `UNSUPPORTED_VERSION`, `NO_SLOT`, `WRONG_KEY`, `TAMPERED`, `BAD_INPUT` |

## Envelope v1

Per email: random 32-byte content key `K`, random 24-byte `nonce`.

`ciphertext` (entity field) = `0x01` (version) || `XChaCha20-Poly1305-IETF(plaintext, ad, nonce, K)` (16-byte tag at the end).

Associated data = `"nanite/email/v1|"` || sorted keyIds joined by `,` (ASCII hex). It binds the ciphertext to the exact recipient set, so stripping or swapping slots fails with `TAMPERED`.

Plaintext serialization (before AEAD):

```
u8  version = 1
u8  flags   (bit0 = rawEml present, bit1 = meta present; other bits must be 0)
u32be len, bytes  subject (UTF-8)
u32be len, bytes  body    (UTF-8)
[u32be len, bytes rawEml]   only if flags bit0
[u32be len, bytes meta]     only if flags bit1 (after rawEml)
```

`meta` is UTF-8 JSON of a plain object, `{ otp?: string, links?: string[] }` (`EmailMeta`): structured agent fields that stay inside the encrypted payload. It is optional and uses the flags byte, so version 1 stays backward compatible: payloads written before `meta` existed (flags 0 or 1) decrypt unchanged, and `decryptEmail` returns `meta` only when present. `rawEml` is reserved for the real raw .eml.

`nonce` (entity field) = the 24 raw bytes. Size overhead: 1 + 2 + 8 (+4 per optional field) + 16 bytes on the ciphertext.

## wrappedKeys v1 (entity field `wrappedKeys`)

```
u8 version = 1
u8 count   (1..255)
count x [ 8 bytes keyId (first 8 bytes of sha256(publicKey))  ||  80 bytes crypto_box_seal(K, recipientPublicKey) ]
```

Slots are sorted by keyId. 2 recipients = 178 bytes. `keyId(publicKey)` is the 16-hex form of the same 8 bytes. `encryptEmail` returns `keyIds` (sorted); if the entity's `keyId` string column must hold them all, store `keyIds.join(',')`.
Adding or removing a reader later means rewriting only `wrappedKeys` (and the AD changes, so it requires re-encrypting the AEAD; the content key is needed, so only an existing reader can do it).

## Wrapped secret v1 (private key under a wrapping key)

`0x01 || nonce(24) || XChaCha20-Poly1305-IETF(secret, ad = 0x01, nonce, wrappingKey)`. Wrong key or tampering gives `WRONG_KEY`.

## Key derivation

- Signature: `KEY_DERIVATION_MESSAGE` (domain + version, distinct from the login message) is signed by the wallet. `wrappingKey = HKDF-SHA256(ikm = signature bytes, salt, info = "nanite/wrap/signature/v1", 32)`. HKDF/HMAC are implemented over libsodium `crypto_hash_sha256` (libsodium's HMAC wrapper fixes the key length; ours accepts any), checked against RFC 4231 / RFC 5869 vectors. At setup sign twice and call `signaturesAreDeterministic`; if false, use the passphrase.
- Recovery code: 25 Crockford base32 chars (125 bits) in 5 groups of 5, e.g. `7K2QD-...`. Input is normalized (case, spaces, dashes, O->0, I/L->1). `Argon2id` (`crypto_pwhash`, ALG_ARGON2ID13), opslimit 2, memlimit 64 MiB, 16-byte salt, password = `"nanite/recovery/v1|" + code`. The code has high entropy, so the cost is modest. Measured ~90-130 ms in Node/WASM.
- Passphrase: Argon2id opslimit 4, memlimit 128 MiB, password = `"nanite/passphrase/v1|" + NFKC(passphrase)`. Measured ~0.25-0.35 s in Node/WASM. 128 MiB (not 256) so mobile browsers do not fail to allocate WASM memory.
- Salts are random 16 bytes (`generateSalt()`), stored beside the wrapped blob; not secret.
- Nanite seed: 32 random bytes (not a BIP-39 mnemonic: nothing is typed by humans, no wordlist, and it avoids importing into a normal wallet). Used as the BIP-32 master seed.
- Agent wallet: `m/44'/60'/0'/0/<index>`. Agent encryption key: `X25519 = scalarmult_base(HKDF-SHA256(seed, salt = empty, info = "nanite/agent-encryption/v1/<index>", 32))`, unrelated to the wallet key.
- senderHash: `userKey = HMAC-SHA256(serverSecret, "nanite/sender-hash/v1/user/" + userId)`; `hash = hex(HMAC-SHA256(userKey, trim(lower(address))))` (a `Name <addr>` form is reduced to `addr`). 64 hex chars.

## Threat notes

- The server sees plaintext at ingestion (Resend delivers plaintext); encryption starts there. Claim: end-to-end from receipt, not from the sender.
- No forward secrecy: ciphertext on Arkiv is public forever; if a recipient private key leaks, all mail wrapped to it is readable. Revoking an agent stops future wraps only.
- Zeroing (`sodium.memzero`) of the content key and plaintext buffers is best effort: JS strings (subject/body) and caller-held arrays cannot be wiped, and the GC may have copied buffers.
- Lengths are not padded; ciphertext size reveals approximate email size. keyIds in the clear reveal which keys can read an entity.
- The served JS must be trusted (a malicious bundle can read keys). Mitigations are in the web app (CSP, SRI, sandboxed rendering).
- Signature-derived keys depend on deterministic wallet signatures (RFC 6979 EOAs). Smart-contract or MPC wallets may differ: use the passphrase.
- Cross-realm note: `utf8()` re-wraps `TextEncoder` output because jsdom-like environments return foreign-realm arrays that libsodium rejects. Callers must pass same-realm `Uint8Array`s.

## Tests

`npm test -w packages/crypto` (vitest). `test/browser.test.ts` runs under jsdom with `Buffer` removed and asserts `src/` has no `node:` imports.
