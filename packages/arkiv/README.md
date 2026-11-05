# @nanite/arkiv

Arkiv schema, read layer and write layer for Nanite email (T1.3 / T1.4). ESM, TypeScript strict, source exports like `@nanite/crypto`. Schema docs: `arkiv/schema.md`.

Dependencies (pinned): `@arkiv-network/sdk` 1.0.1, `viem` 2.21.54. Chain: Rabdi (7794095).

## Entrypoints

- `@nanite/arkiv`: schema, reads, types, errors. Browser-safe (no `viem/accounts`, no `node:*`).
- `@nanite/arkiv/writer`: writes (imports `viem/accounts`; server only). Also re-exports the errors.

## Reads

```ts
import { createArkivReader } from '@nanite/arkiv';
const arkiv = createArkivReader({ operatorAddress, accessKey /* optional */, rpcUrl /* optional */ });

await arkiv.listInbox({ agentId, ownerId?, owner?, types?, before?, after?, limit /* 1..100, default 25 */, cursor?, includeBytes? });
// -> { items: EmailRecord[], nextCursor?, skipped }   ordered by receivedAt desc
await arkiv.latestOtp(agentId);        // EmailRecord | null
await arkiv.getEmail(entityKey);       // EmailRecord | null; throws UntrustedEntityError on wrong $creator / schema
await arkiv.countInbox({ agentId, ... });
await arkiv.waitForQueryable(entityKey, { timeoutMs, intervalMs });
arkiv.buildInboxQuery({ agentId, ... }); // the exact query string, for logs and docs
```

- `operatorAddress` is mandatory: every query is pinned to `$creator = addr(operator)` and every returned row is re-checked. `owner` additionally pins `$owner`; `ownerId` filters the indexed attribute.
- `EmailRecord` = `$key, $owner, $creator, $expiresAt` (block number, bigint), the plaintext columns (`receivedAt` is a number of unix seconds, `keyIds` a string array) and `ciphertext`, `wrappedKeys`, `nonce` as `Uint8Array`, so it can go straight into `decryptEmail`. With `includeBytes: false` the byte fields are empty arrays.
- `before` / `after` are exclusive unix seconds. The cursor is an opaque offset (the SDK has no cursor in 1.0.1); use `before` for stable walks while mail arrives.

## Writes

```ts
import { createArkivWriter, expiryPlan } from '@nanite/arkiv/writer';
const writer = createArkivWriter({ privateKey /* operator */, accessKey?, rpcUrl?, otpTtlSeconds?: 300, maxAttempts?: 3 });

const { entityKey, txHash, attempts } = await writer.writeEmail({
  fields: { agentId, ownerId, type, receivedAt, threadId, senderHash, keyIds, ciphertext, wrappedKeys, nonce },
  owner,                       // final $owner (the user wallet)
  expiresIn?,                  // seconds | 'max'; default by type
  permissionlessExtension?,    // default true except OTP; true on an OTP throws
});
await writer.extendEmail(entityKey);          // to max; only works on permissionlessExtension entities
await writer.waitForQueryable(entityKey);     // poll until a creator-pinned query sees it
```

- One `executeBatch` per email: create + `changeOwnership` to `owner` (skipped if owner is the operator). `predictEntityKeys` runs right before each send; a revert re-predicts and retries up to `maxAttempts`.
- All writes and extensions of one writer go through a FIFO queue with concurrency 1 (`writer.queue`), so concurrent callers never race the nonce. Use one writer instance per operator account per process.
- Expiry: OTP 5 min (configurable), conversation/sent `ExpirationTime.max()` (about 182.5 days).
- Size guard: `ciphertext + wrappedKeys + nonce > 125 KiB` throws `EntityTooLargeError` before anything is queued. `keyIds` (from `encryptEmail`) is stored sorted and comma-joined (max 7 keyIds, 128-byte column).
- Errors never contain ciphertext or email content: `EntityTooLargeError`, `InvalidEmailFieldsError`, `ArkivWriteError`, `UntrustedEntityError`, `QueryTimeoutError`.

## Tests

```
docker compose run --rm tools npm test -w packages/arkiv                  # unit tests (SDK client on an in-memory fake node, fake write backend)
docker compose run --rm tools npm run test:live -w packages/arkiv         # LIVE_ARKIV=1: writes one email on Rabdi, reads it back
```

The live test derives the W3 operator (index 3) and user (index 4) from `ARKIV_TEST_MNEMONIC` in memory; keys are never printed.
