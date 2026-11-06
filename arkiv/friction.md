# Friction

## Arkiv feedback

**Three problems cost us the most: the real size limit is lower than the documented one, the documented negation (`ne`, `not`) does not work, and two different failures return the same error.**

Words used below:

- *entity*: one stored record on Arkiv.
- `$creator`: the wallet that wrote the entity. It never changes. `$owner`: the wallet that controls it now.
- *batch*: several writes in one transaction (`executeBatch`).
- *spike*: our first round of Arkiv tests, on 2026-11-05 ([docs/arkiv-spike/](../docs/arkiv-spike/W1.md)).
- *size*: the total of an entity's `bytes` columns (ciphertext, keys and nonce), in bytes (B).

How we checked:

- We built Nanite on the Rabdi testnet with `@arkiv-network/sdk@1.0.1`, the latest version on 2026-11-06.
- Exact requests, responses, transaction hashes and docs quotes are in [friction-evidence.md](friction-evidence.md).
- **Re-run on 2026-11-06 against the live node:** items 1 to 6 and 8 to 11, and the slow-RPC part of item 12.
- **Not re-run:** the batch part of item 1 (spike only), and the connection hang in item 12 (seen once on 2026-11-05).
- **No script:** item 7 (read from the SDK source) and the connection hang in item 12.
- We dropped every item we could not reproduce, and every item that turned out to be documented. The evidence file lists them, with reasons.

Every script runs with the same prefix:

```
docker compose run --rm tools npx tsx scripts/arkiv/repro/<file>.ts
```

The scripts are in [`scripts/arkiv/repro/`](../scripts/arkiv/repro/). Read-only scripts need no key. Scripts that write (`size-limit.ts --write`, `nonce-race.ts`, `permissionless-extension.ts`, `transfer-without-consent.ts`, `read-after-write.ts`) use test wallets from `ARKIV_TEST_MNEMONIC` in `.env`.

## Top 3

| # | Problem | Kind | Cost to a builder |
| --- | --- | --- | --- |
| 1 | Creates under the documented 128 KiB fail on chain | Limit not documented | You find the real limit by trial and error |
| 2 | `ne` and `not` are in the docs, but not in the SDK, and the node rejects both | Docs, SDK and node disagree | You cannot write "everything except X" |
| 3 | "Too large" and "parallel batch clash" give the same error text | Error message | You cannot tell whether to shrink the data or retry |

### 1. The real size limit is lower than what the docs and the SDK check

- **Docs say:** the [limits page](https://docs.arkiv.network/reference/limits/) allows 128 KiB (131,072 B) of `bytes` values in one create. The SDK throws `EntityTooLargeError` only above 131,072 B. The page lists no transaction size limit and no batch limit.
- **What happened (2026-11-06):**
  - With our current email schema (seven attributes), 128,272 B landed. 128,400 B and everything above failed with `Execution error without revert data`.
  - With a schema of one string column, 128,448 B landed and 129,672 B failed.
  - So the limit moves with the other attributes in the same transaction.
- **Our guess (not confirmed by Arkiv):** the whole transaction input is capped at about 130,900 B. The largest input that landed was 130,916 B. That was a spike entity with an earlier, smaller schema. Its 128,400 B of data fit in that schema but not in our current one.
- **Batches:** in the spike, 4 emails of 24.6 KiB landed in one batch and 5 did not. Not re-run.
- **Good news:** a rejected create costs no gas. It fails during gas estimation, before anything is sent.
- **Why it matters:** the SDK accepts sizes that then fail on chain. A builder has no number to design against.
- **Reproduce:** `size-limit.ts --write <ciphertextBytes> [--min]`. The size is ciphertext plus 172 B of keys and nonce. Try 128100 (lands) and 128228 (fails). `--min` uses the one-column schema.
- **Suggested fix:** document the transaction size limit and how attributes count toward it. Make the SDK check use it. Name the cause in the error.
- **What we do:** Nanite caps size at 125 KiB (128,000 B). That lands with our schema.

### 2. Negation does not work: the docs, the SDK and the node disagree

- **Docs say:** the [`ne` page](https://docs.arkiv.network/typescript-sdk/api-reference/query/functions/ne/) shows `ne("status", str("closed"))  // status != str('closed')` and `not(eq(...))  // NOT status = str('closed')`.
- **What happened:**
  - SDK 1.0.1 exports neither `ne` nor `not`. It does export `startsWith`.
  - The node rejects `agentId != str('zzz')` with `-32002 != is not part of the query language — write NOT (attr = value) for the complement`.
  - We followed that advice. `NOT (agentId = str('zzz'))` returns `-32603 query: store: NotImplemented`.
- **Why it matters:** you cannot ask for "all mail except one-time codes". The node's own suggested rewrite fails too.
- **Reproduce:** `u1-substring.ts` (the `!=` case) and `q-negation-cursor.ts` (the SDK exports and the `NOT (...)` forms).
- **Suggested fix:** ship `ne` and `not` in the SDK and make `NOT` work in the node. Or remove them from the docs and make the `!=` error say negation is not available.
- **What we do:** we list the values we want with `or(eq(...), ...)`.

### 3. Two different failures return the same error text

- **Expected:** an error that names its cause.
- **What happened:** a transaction that is too large (item 1) and a second parallel batch from the same account (item 4) both fail with `Execution error without revert data`.
- **Why it matters:** the right reaction differs. Too large means "shrink the data". A clash means "wait and retry". The caller cannot tell which.
- **Reproduce:** `size-limit.ts --write 128228` and `nonce-race.ts`. Both print the same message.
- **Suggested fix:** return a revert reason, for example `TransactionTooLarge` or `StaleKeyPrediction`.

## Other issues, highest impact first

### 4. Create-and-transfer in one batch breaks when two batches run at once

- **Docs say:** the [batches page](https://docs.arkiv.network/writing/batches/) says "A prediction holds only while nothing else from the same account lands first." It does not cover parallel writes.
- **Background:** we create each email and hand it to the user's wallet in one batch. For that, the new entity's key must be known in advance. `predictEntityKeys` predicts it from the writer's next nonce (a counter that goes up with each write).
- **What happened:** we sent two batches at the same time with the same prediction. One landed. The other failed with `Execution error without revert data`. It created nothing and moved nothing, so it fails safe. An explicit `salt` does not help, because the key includes the nonce.
- **Why it matters:** any app that writes in parallel from one account will see random failures, with an error that does not explain them (item 3).
- **Reproduce:** `nonce-race.ts`
- **Suggested fix:** let `changeOwnership` in a batch point to "the entity created at position i of this batch". Then no prediction is needed.
- **What we do:** one write at a time per account (a single-flight queue), and we predict again after a failure.

### 5. The node has a page `cursor` that the docs and the SDK do not mention

- **Docs say:** the [JSON-RPC page](https://docs.arkiv.network/json-rpc/querying-data/) documents paging by `offset` or by `$key`.
- **What happened:** `arkiv_query` returns `"cursor": "b64:..."` when more rows exist. Sending it back as `{"cursor": ...}` returns the next page. SDK 1.0.1 has no cursor.
- **Why it matters:** with `offset`, pages shift when new mail arrives between requests. A cursor fixes that, but builders do not know it exists.
- **Reproduce:** `q-negation-cursor.ts`
- **Suggested fix:** document the cursor and expose it in the SDK.

### 6. Expired data stays readable in the transaction that created it

- **Docs say:** the [expiration page](https://docs.arkiv.network/writing/expiration/) says nothing about the original transaction.
- **What happened:** after expiry, `arkiv_getEntity` returns `null` and queries return nothing. But `eth_getTransactionByHash` for the creating transaction still returns the full input data (2,820 B in our test).
- **Why it matters:** this is normal for a blockchain. But anyone who stores something they expect to disappear should be told that it does not fully disappear.
- **Reproduce:** `expiry-history.ts`
- **Suggested fix:** one sentence on the expiration page.
- **What we do:** we encrypt everything before it is written.

### 7. `watchEntityEvents` has no filter

- **Expected:** a way to watch only your own entities.
- **What happened:** `WatchEntityEventsParameters` takes handlers and a polling interval only. On a shared testnet every client receives every event and filters it locally.
- **Why it matters:** a live inbox has to download everyone's events to find its own.
- **Check:** SDK source `actions/public/watchEntityEvents.ts`. No script.
- **Suggested fix:** a server-side filter by owner, creator or schema.

### 8. No substring search: only exact match and prefix

- **Docs say:** the language has `=`, ranges, `BETWEEN` and `STARTSWITH`, and they all work. So this is a feature request, not a bug.
- **What happened:** `CONTAINS`, `LIKE`, `GLOB` and `ENDSWITH` return `-32001 expected a comparison operator (= < <= > >= BETWEEN STARTSWITH)`. The node says the old `~` glob "was removed".
- **Why it matters:** to search inside names, an app must store extra prefix columns.
- **Reproduce:** `u1-substring.ts`
- **Suggested fix:** `CONTAINS` on an indexed string.

### 9. Aggregates stop at a total count

- **Docs say:** the count page documents a total count only.
- **What happened:** `select.count` (and the SDK's `count()`) returns a total for any filter, computed on the node. We use it. There is no `SUM`, `GROUP BY` or `DISTINCT` (`-32001 unexpected trailing input`).
- **Why it matters:** "mail per sender" or "mail per day" means paging through every row.
- **Reproduce:** `u2-aggregates.ts`
- **Suggested fix:** a count grouped by one attribute.

### 10. No arithmetic, variables or functions in queries

- **Expected:** SQL habits, like "received in the last hour".
- **What happened:** `receivedAt > u64(1793900000) - u64(3600)` returns `-32001 expected digits after the sign`. `now()`, `$now` and `$blockNumber` return `-32001 expected a value`.
- **Why it matters:** the caller computes every time or block number itself (the current block comes from `arkiv_getBlockTiming`). Low impact, but it surprises people.
- **Reproduce:** `u3-expressions.ts`
- **Suggested fix:** a value for "current block" inside a query.

### 11. Only one `ORDER BY` key

- **Docs say:** the docs show one key, so this is a request, not a bug.
- **What happened:** `ORDER BY type:str ASC, receivedAt:u64 DESC` returns `-32001 unexpected character` at the comma.
- **Why it matters:** you cannot break ties, for example two emails received in the same second.
- **Reproduce:** the last lines of `transfer-without-consent.ts`. There is no read-only script for this; that script also writes, so it needs the test wallets.
- **Suggested fix:** accept more than one sort key.

### 12. Public RPC: one slow burst and one hang, neither seen again

- **Slow burst:** on 2026-11-06 between 08:04 and 08:06 UTC, 4 of 25 `arkiv_query` calls took more than 5 s (up to 23.4 s), all with HTTP 200. At 08:11 UTC, 20 queries in a row took 249 to 674 ms (median 286 ms). Reproduce: `u4-query-latency.ts` and `u4-hosts.ts`.
- **Hang:** on 2026-11-05 the Rabdi RPC and explorer hung after the TLS handshake from one network, while the status page said all was fine. Switching network fixed it. No script; not seen since.
- **Why it matters:** a request that hangs for 23 s looks like an outage to a user. We do not claim a lasting problem.

## Docs gaps, in one place

1. The API reference lists `ne` and `not`. Their examples turn into queries the node rejects (item 2).
2. The limits page does not list the transaction size limit that actually applies to a create or a batch (item 1).
3. The JSON-RPC page documents `offset` and `$key` paging, but not the `cursor` the node returns (item 5).
4. The expiration page does not say that the creating transaction keeps the data (item 6).

## Documented limits that shaped our design (not complaints)

- **Maximum lifetime is 7,884,000 blocks, about 182.5 days** (one block is 2 s). Long retention needs a job that extends entities. A missed window loses the data.
- **An extension can only move expiry later, and it counts from now.**
- **`changeOwnership` needs no consent from the new owner.** So an attacker can give your wallet a look-alike entity. Re-tested 2026-11-06 with `transfer-without-consent.ts`. That is why every Nanite query pins `$creator`, not just `$owner`.
- **`permissionlessExtension` lets anyone extend an entity, but not edit or delete it.** "Anyone can extend" and "cannot delete" were re-tested on 2026-11-06 with `permissionless-extension.ts`. "Cannot edit" comes from the spike ([W2](../docs/arkiv-spike/W2.md) test 4, [W3](../docs/arkiv-spike/W3.md) test D).

## What worked well

- **Ownership errors are precise.** Example: `entity 0xded8ebd7…a60dab is owned by 0x5751…8186, not 0xE1c9…c99B`. A shorter extension says `already expires at block 285451, so extending it to 285212 would shorten its life`.
- **`executeBatch` works as documented.** Create plus `changeOwnership` in one transaction works, and a wrong key prediction reverts the whole batch.
- **Expiry is exact to the block.** A 60-second entity (30 blocks) was gone from queries within about 4 s of its expiry block (spike W2, [results/W2.json](../docs/arkiv-spike/results/W2.json)).
- **Reads are fast after a write.** On 2026-11-06, `getEntity` saw a new entity 0.2 to 0.3 s after the receipt, and queries 0.5 to 0.6 s after (4 runs, `read-after-write.ts`).
- **No rate limiting hit.** The public RPC handled our parallel test agents and 20 queries in a row without a 429.
- **Cost is predictable.** Gas is a flat 1 gwei (`eth_gasPrice` = 0x3b9aca00): about 164k gas plus about 40 gas per byte of data (spike W1).
- **The query layer stayed small.** `STARTSWITH`, `BETWEEN`, the node-side `count` and the SDK's error classes did most of the work. The SDK's `rabdi()` error names the exact fix.

## Not Arkiv

ENS, tooling and our own MCP kit bugs are in [build-notes.md](build-notes.md).
