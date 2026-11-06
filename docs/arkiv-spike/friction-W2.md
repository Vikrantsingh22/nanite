# Friction W2

- `flags` option is an object `{ permissionlessExtension: true }`, not a number. sdk-notes described the bit (0x02) but a numeric 0x02 was silently accepted and ignored by `createEntity` (entity got raw=0). Wasted a run: test 4 initially "failed" because the flag never applied. Worth a validation error.
- Schema values need explicit wrappers (`addr()`, `u64()`, `str()`, `bytes()`) for a named schema even though sdk-notes says bare JS forms are accepted; plain string for addr column and bigint (inferred u256) for u64 column both throw.
- `extendEntity` once failed with "ran out of gas: used all 31976 gas" (estimate from stale state); a retry succeeded. Fee was still spent.
- Rabdi explorer is a JS SPA; `fetch` of /entity/<key> and /tx/<hash> returns a ~1 KB shell, so expired-entity visibility there cannot be checked without a real browser.
- `watchEntityEvents` on a shared testnet delivers every worker's events; filtering by owner is not an option in the API (filter client-side).
- No raw node-level check of over-max expiry: the SDK pre-check (`InvalidExpiryError`) always fires first; would need hand-built `execute` calldata.
- A first background run sat 12 min polling for funds and then failed 6 tests on the schema wrapper issue; typecheck passed because values are loosely typed (`as any` in my helper hid it).
