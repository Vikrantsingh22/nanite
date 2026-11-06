# Friction W1

- Faucet funding took ~35+ minutes after the wallet was needed; polling consumed a long time.
- Bare JS values are not coerced for all columns: `ownerId` (addr column) with a plain string and `receivedAt` (u64 column) with a bigint both threw `SchemaMismatchError` (bigint is treated as u256). Must wrap with `addr()` / `u64()`. sdk-notes said "bare JS forms accepted"; that is only true for some types.
- `executeBatch` create items are flat (`{schema, values, expiration}`), not `{options: {...}}`; passing `options` gives a misleading `InvalidExpiryError`.
- `getEntity(key, schema)` returns bytes columns as `{type, value}` objects, not Uint8Array, even with the schema passed (value shape not inspected beyond that; the byte-exact check used `.value`).
- Biggest one: on-chain failures show only "Execution error without revert data" with no size hint. The SDK's 128 KiB check does not match the real limit (~128,2xx ciphertext bytes with 172 B of other bytes columns; whole batches limited likewise). Found only by bisecting, which cost real tGLM on each success.
- Public RPC without access key worked fine for this volume; no 429s observed.
- `tsc` rejects `.ts` import extensions; scripts import `./lib` without extension (the task text used `lib.ts`).
