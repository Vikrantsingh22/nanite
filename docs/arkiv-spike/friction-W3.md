# Friction W3

- Public (keyless) RPC: reads lag the writer by seconds; every read needs a poll loop. Query for `$owner` right after a tx often returns the old state.
- `getEntity`/`select` return FLAT rows (`$owner`, `$creator`, `$creationFlags`, `$expiresAt`, attributes by name), not `entity.owner`. sdk-notes.md did not say this; I read it as `e.owner` first and got undefined.
- Schema values must be wrapped (`addr()`, `u64()`), even for named schemas: bare strings/bigints throw `a addr column, but the value is a str` / `u256`. Bare bigint infers u256.
- The nonce race is silent from the SDK: `predictEntityKeys` has no lock or "reserve" concept; a concurrent create gives an opaque `Execution error without revert data` on one of two concurrent batches (cannot tell if gas was burned).
- An explicit salt does not help with the race (sdk-notes hint implied it might). Key always depends on the creator nonce.
- Revert messages from the SDK are good ("owned by X, not Y", "created readonly...").
- `.ownedBy()` queries by agentId matched older test entities from a previous run; use unique tags per run in tests.
- Docker: `sed -i` on macOS host needs `''`; BSD sed rejects `\n` in replacements. First run died at the `u64` wrapping, wasting a few txs (harmless).
