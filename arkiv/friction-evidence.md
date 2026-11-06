# Arkiv friction: evidence

Audit run on 2026-11-06 (08:04 to 09:12 UTC). Every item in [friction.md](friction.md) is backed by a command below, a docs quote, or a dated result file. Items that did not survive the audit are listed at the end with the reason.

- Chain: Rabdi testnet (7794095). RPC `https://rpc.rabdi.db-chain.testnet.arkiv.network`, public keyless endpoint. SDK `@arkiv-network/sdk` 1.0.1 (also the latest on npm: published 2026-11-02; `npm view` checked 2026-11-06).
- Read-only repros need no key. Write repros use the spike test wallets from `ARKIV_TEST_MNEMONIC` (indexes 1, 4 as receiver only, 7), never the operator key. All repro scripts are in [`scripts/arkiv/repro/`](../scripts/arkiv/repro/) and run as `docker compose run --rm tools npx tsx scripts/arkiv/repro/<file>.ts`.
- Prefix `P` in the queries below: `arkiv.schema = str('nanite.email.v1') AND $creator = addr(0xA7B7EbE69F1bcb3ACD680d5e06cE640E0D2D247F)` (the operator that wrote our live entities, 16 of them at block 285,208).

## Verdict table

| ID | Claim | Verdict |
| --- | --- | --- |
| U1 | No `contains` / LIKE / glob; only prefix and exact match | KEEP (true; `STARTSWITH` exists and works) |
| U2 | No aggregates (SUM, GROUP BY) | KEEP, narrowed (total `count` exists; nothing else) |
| U3 | No arithmetic, variables or functions in queries | KEEP (true) |
| U4 | Website very slow / Cloudflare 522 | NOT ESTABLISHED: no 522 evidence; separate timing facts recorded below |
| E1 | Effective create size is below the documented 128 KiB, error has no hint | KEEP, reworded with new numbers (it is the whole-transaction size) |
| E2 | Docs and SDK 1.0.1 disagree (`ne`, `not`, cursor, `atBlock`, `for await`) | FIX WORDING: `ne`/`not` yes; cursor/`atBlock`/`for await` are not in the current docs; raw RPC cursor is a different, real gap |
| E3 | `flags: 0x02` silently ignored | REMOVE (TypeScript rejects it; we used `as any`) |
| E4 | Bare JS values not coerced for `addr` / `u64` | REMOVE (documented behaviour) |
| E5 | Nonce race when creating and transferring in one batch | KEEP, reworded (documented caveat; the error is opaque) |
| E6 | Quoted address literals rejected | REMOVE (docs show the unquoted form) |
| E6b | Raw `ORDER BY` needs the type | REMOVE (documented) |
| E7 | Undocumented response shapes (`skipped`, flat `$owner`, `{type,value}`, hex strings) | REMOVE (all documented on the get-entity, select and JSON-RPC pages) |
| E8 | `{options}` batch item gives misleading `InvalidExpiryError` | REMOVE (message is accurate, TypeScript catches it) |
| E9 | `rabdi()` with no argument throws | REMOVE (error message says exactly what to do) |
| E10 | No expiry event; `watchEntityEvents` has no filter | FIX WORDING: expiry event is documented as absent; keep only "no filter" as a small request |
| E10b | Events sometimes arrive before the SDK receipt wait returns | REMOVE (two samples, not re-run) |
| E11 | Stale reads 0.3 to 2 s after a receipt | REMOVE as friction (today 0.2 to 0.6 s, no misses); kept as a design note elsewhere |
| E12 | Max lifetime 182.5 days | FIX WORDING: documented limit, listed as a design note not a complaint |
| E13 | Expired data stays readable in the creating tx calldata | KEEP, as a docs request (reproduced) |
| E14 | Explorer is a JS app | REMOVE (not an Arkiv problem) |
| E15 | Faucet requires connecting the receiving wallet | REMOVE (cannot be re-verified from a terminal) |
| E16 | RPC/explorer hung after TLS on one network on 2026-11-05 | KEEP as a dated observation, not reproduced (see U4) |
| E17 | Extend ran out of gas on a stale estimate | REMOVE (one-off; SDK message explains and says to resend) |
| N1 | `!=` rejected, `NOT` accepted by the parser but fails with `NotImplemented`; docs list `ne`/`not` | NEW, KEEP (highest impact in query language) |
| N2 | Raw RPC returns and accepts a `cursor`; SDK and docs do not expose it | NEW, KEEP (small) |
| N3 | Only one `ORDER BY` key | NEW, KEEP (small; docs show one key) |
| N4 | Same opaque error text for two different causes (size, nonce race) | NEW, KEEP (merged into E1/E5) |

## U1: substring matching

Docs ([query language reference](https://docs.arkiv.network/reference/query-language/), fetched 2026-11-06): comparisons are `=`, `<`, `<=`, `>`, `>=`, `BETWEEN low AND high`, `STARTSWITH str('prefix')` ("a `str` that starts with the prefix"), `EXISTS(name)`, `TYPEOF(name) = type`. No contains, LIKE or glob is listed. [Filter page](https://docs.arkiv.network/querying/filter/): `startsWith(name, prefix)` is the only string function. The page also says the language "only sees indexed attributes".

Script: `scripts/arkiv/repro/u1-substring.ts`, run at 08:04 UTC. Each query is `P AND <clause>` on `agentId` via `arkiv_query` (options `{"select":{...},"limit":"0x3"}`):

| Clause | Result |
| --- | --- |
| `agentId = str('alex.vikrant.nanitecom.eth')` | OK, count 6 |
| `agentId STARTSWITH str('alex.')` | OK, count 12 (also lower-case `startswith`) |
| `agentId STARTSWITH str('zzz')` | OK, count 0 |
| `agentId STARTSWITH str('vikrant')` (a middle fragment) | OK, count 0: it is a prefix match only |
| `startsWith(agentId, str('alex.'))` (function form) | error -32001 `unexpected character` |
| `agentId ENDSWITH str('.eth')` | error -32001 `expected a comparison operator (= < <= > >= BETWEEN STARTSWITH)` |
| `agentId CONTAINS str('vikrant')` | same -32001 error |
| `contains(agentId, str('vikrant'))` | -32001 `unexpected character` |
| `agentId LIKE str('%vikrant%')` | -32001 `expected a comparison operator (...)` |
| `agentId GLOB str('*vikrant*')` | -32001 `expected a comparison operator (...)` |
| `agentId ~ str('*vikrant*')` | -32001 `symbol operators (&& \|\| ~) were removed — use AND, OR, STARTSWITH` |
| `agentId = str('*vikrant*')` | OK, count 0 (literal compare, no wildcard) |
| `agentId IN (str('...'))` | -32001 `expected a comparison operator (...)` |

Verdict: the claim is correct. The language has exact match, ranges and `STARTSWITH` only. `~` (glob) existed earlier and was removed (the node says so). Wording for the report: "no substring search; prefix and exact only". It is a documented limitation, not a bug. SDK 1.0.1 exports `startsWith` and renders it as `agentId STARTSWITH str('alex.')`.

## U2: aggregates

Docs: the [count page](https://docs.arkiv.network/querying/count/) documents only counting ("`count` takes the same filters as `select`"); it and the query language page list no sum, average, min/max or grouping. Script `scripts/arkiv/repro/u2-aggregates.ts` (08:05 UTC):

| Request | Result |
| --- | --- |
| `arkiv_query(P, {select:{count:true}, limit:"0x1"})` | OK, `count` 16, no rows: **a node-side total count is supported** |
| same with `AND type = str('conversation')` | OK, count 11 |
| `COUNT(*) WHERE P`, `SELECT COUNT(*) FROM entities WHERE P` | -32001 `expected a comparison operator (...)` |
| `P GROUP BY type` | -32001 `unexpected trailing input — did you mean to join these with AND or OR?` |
| `SUM(receivedAt) WHERE P` | -32001 `expected a comparison operator (...)` |
| `P DISTINCT agentId` | -32001 `unexpected trailing input` |
| JSON-RPC methods `arkiv_count`, `arkiv_aggregate` | -32601 `the method ... does not exist/is not available` |

Our reader's `countInbox` (`packages/arkiv/src/reader.ts`) calls the SDK `client.count().from(schema).createdBy(op).where(...).fetch()` which uses the node-side `count` projection (SDK source `query/queryBuilder.ts`: `count: this._withCount`, "Also counts every entity the query matches, regardless of the limit and offset"). It is not client-side paging. Nanite's apps do not call `countInbox` today (only the package and its tests do).

Verdict: "no aggregates" is correct for SUM / AVG / GROUP BY / DISTINCT; a filtered total count exists. Wording: "only a total count, no grouped or summed values".

## U3: arithmetic, variables, functions

Docs: none of these appear in the query language reference (values are typed literals such as `u64(1700000000)`). Script `scripts/arkiv/repro/u3-expressions.ts` (08:06 UTC, block 283,304 from `arkiv_getBlockTiming` -> `{"current_block":283304,"current_block_time":1793952372,"duration":2}`):

| Clause | Result |
| --- | --- |
| `receivedAt > u64(1000000000)` | OK (baseline) |
| `receivedAt > u64(1793900000) - u64(3600)` | -32001 `expected digits after the sign` |
| `receivedAt > 1793900000 - 3600` | -32001 `expected digits after the sign` |
| `receivedAt + 3600 > u64(...)` | -32001 `expected digits after the sign` |
| `receivedAt > now()` | -32001 `expected a value, e.g. i32(10) or str('Bob')` |
| `receivedAt > $now`, `$expiresAt > $blockNumber` | -32001 `expected a value, e.g. i32(10) or str('Bob')` |
| `$expiresAt - u64(1000) > u64(0)` | -32001 `expected digits after the sign` |
| `$expiresAt > u64(283304)` (literal) | OK |
| `agentId = threadId` (two columns) | -32001 `expected a value, e.g. i32(10) or str('Bob')` |
| `$createdAt > u64(0)` | -32002 `$createdAt is not queryable — it is returned by projections only` (documented: "`$createdAt` and `$updatedAt` can't be sorted on") |

Verdict: correct. The client computes the literal (`before`/`after` in our reader do exactly that) and the block for `$expiresAt` comes from `arkiv_getBlockTiming`. Low impact, but it means every "last hour" or "expires within a day" query is built by the caller.

## U4: slow site / Cloudflare 522

What we searched: `docs/logbook.md`, `arkiv/friction.md`, `docs/arkiv-spike/**`, `claude/*.md`, `apps/api/LIVE-*.md` for `522`, `Cloudflare`, `slow`, `timed out`. **No record of a 522 anywhere.** The only recorded outage is W0 (2026-11-05): "the Rabdi RPC and explorer hang after the TLS handshake from this machine (host and Docker, IPv4 and IPv6); docs, hub and status respond, and the status page says all is operational" (`docs/logbook.md` line 35, `docs/arkiv-spike/friction-W0.md`). That is a TLS hang, not a 522, and was specific to one network.

Measured now, from the `tools` container, `scripts/arkiv/repro/u4-hosts.ts` (2026-11-06 08:11 UTC, 6 samples each, status/time):

| Host | Results |
| --- | --- |
| docs.arkiv.network | 200 x6, 331 to 1053 ms |
| hub.arkiv.network | 200 x6, 193 to 783 ms |
| rabdi.explorer.arkiv.network | 200 x6, 213 to 677 ms |
| rpc.rabdi.db-chain.testnet.arkiv.network (GET) | 405 x6 (a GET is not valid for JSON-RPC), 197 to 352 ms |
| same RPC, POST `eth_chainId` / `arkiv_getBlockTiming` | 200 x12, 206 to 262 ms |
| indexer.rabdi.db-chain.testnet.arkiv.network | 200 x6, 196 to 707 ms |

`scripts/arkiv/repro/u4-query-latency.ts` (08:11 UTC, 20 sequential `arkiv_query` calls): all HTTP 200, 249 to 674 ms, median 286 ms.

But the first query bursts of the same session were slow. During `u1-substring.ts` and `u2-aggregates.ts` (08:04 to 08:06 UTC, 25 `arkiv_query` calls, all HTTP 200) the first call took 23,351 ms, then 1,374; 5,553; 11,212; 2,579; 906; 2,792; ... and in the U2 run 2,504 to 6,654 ms. Four calls took more than 5 s (23.4 s, 11.2 s, 6.7 s, 5.6 s) and the same calls took 0.5 to 1 s minutes later. So an intermittent slowdown of the public keyless RPC was observed, with no error status.

Verdict for U4: no 522 evidence; cannot be stated as a finding. What we can state, factually: "Observed on 2026-11-06 between 08:04 and 08:06 UTC: `arkiv_query` on the public keyless RPC took up to 23 s per call (4 of 25 calls above 5 s); at 08:11 UTC the same query took a median 286 ms. Not reproduced since." The 522 needs a host and a date from Vikrant before it can go in (see report).

## E1: effective create size

Docs: [limits](https://docs.arkiv.network/reference/limits/): "Entity size (all bytes values in one create or patch): 128 KiB"; the page lists no transaction size and no batch limit. [Create page](https://docs.arkiv.network/writing/create/): `EntityTooLargeError` is thrown when "the bytes values add up to more than 128 KiB".

Repro `scripts/arkiv/repro/size-limit.ts` (test wallet index 1; ciphertext + `wrappedKeys` 160 B + `nonce` 12 B; 60 s lifetime):

| Shape | Ciphertext bytes | Total bytes columns | Result |
| --- | --- | --- | --- |
| 1 string column ("min") | 128,180 | 128,352 | LANDED tx `0x4fefdef9f7719bc37c293f5300465eae0f4e39bb8d8ae6bfaacc7397c6237a82` |
| min | 128,276 | 128,448 | LANDED tx `0xdaa5b1cdb7392bab0a8def30cf5f16abce1db93306c456ce1069654e97c3bfab` |
| min | 129,500 / 130,000 / 130,400 / 130,800 | 129,672 to 130,972 | `EntityMutationError: Transaction failed: Execution error without revert data` (all four) |
| `nanite.email.v1` (7 attributes + 3 bytes) | 127,828 | 128,000 | LANDED tx `0x443f671b84a65450575e4a30bd1db2363fe57e9f2a901b624364d4bc66468fd1`, tx input 130,532 B |
| email | 128,100 | 128,272 | LANDED tx `0x9cf127549d30bf9ba3e7b8da0088f69aec09c11e0f353105d280f13df294b47b`, tx input 130,820 B |
| email | 128,228 / 128,250 / 128,276 / 129,500 / 130,000 / 130,800 | 128,400 to 130,972 | fails with the same error |
| spike (v0 schema, 2026-11-05) | 128,228 | 128,400 | landed, tx `0x6c55c5e24394ee5530886eb699107ce6cddd01135d8ef611547dff7d51aeec4a`, input 130,916 B (read back today) |

All values are below the SDK's own 131,072 B check. The failures happen **before anything is sent** (`txHash` empty, wallet balance change 0 wei, measured with the script's before/after balance): the node's gas estimation fails with the error text above. The accepted maximum depends on the other attributes of the entity: the same 128,276 B ciphertext lands with one string column and fails with our seven-attribute schema. This is consistent with a cap on the whole transaction input of about 130.9 KB (the largest landed input is 130,916 B; failures would exceed about 131,000 B). Our guard (ciphertext + wrappedKeys + nonce <= 125 KiB = 128,000 B) lands for the real schema (tx input 130,532 B), so it is safe. The mechanism is our inference; the observations are the table.

Correction to the earlier text: a failed size attempt costs no gas (the 2026-11-05 note "cost: real transactions" applies only to the successful bisect steps). Batches: spike W1 (not re-run) landed 4 x 24.6 KiB in one `executeBatch` (tx `0x5201f87b...b877eb`) and failed with 5; the limits page documents no batch limit.

## E2 / N1 / N2 / N3: docs, SDK and node on negation, cursor, ordering

Script `scripts/arkiv/repro/q-negation-cursor.ts` (08:07 UTC):

- SDK 1.0.1 `@arkiv-network/sdk/query` exports: `has ne: false, has not: false, has startsWith: true`.
- Docs [API reference](https://docs.arkiv.network/typescript-sdk/api-reference/) lists `ne`, `not`, `startsWith`. The [`ne` page](https://docs.arkiv.network/typescript-sdk/api-reference/query/functions/ne/) says: "`ne("status", str("closed"))  // status != str('closed')`" and "`not(eq("status", str("closed")))  // NOT status = str('closed') — also matches entities with no status`".
- Node, `P AND agentId != str('zzz')`: error -32002 `!= is not part of the query language — write NOT (attr = value) for the complement`.
- Node, `P AND NOT (agentId = str('zzz'))` and `P AND NOT (type = str('otp'))` and `P AND NOT agentId = str('zzz')`: error -32603 `query: store: NotImplemented`.

So the documented negation (`ne`, `not`) is missing from the SDK, and the node's own suggested rewrite fails. We work around it with `or(eq(...), ...)` over the types we want.

Cursor: `arkiv_query(P, {select:{key:true}, limit:"0x2"})` returns `{"data":[...],"blockNumber":"0x...","cursor":"b64:RW2JxmVkvn4AAAAAAAAAAg"}`. Sending `{"limit":"0x2","cursor":"b64:..."}` as the next call returns the next two rows (keys disjoint from page 1). The [JSON-RPC page](https://docs.arkiv.network/json-rpc/querying-data/) documents `select`, `limit`, `offset` and the response fields `data`, `blockNumber`, `count`, and recommends `offset` or `$key > key(0x...)` paging; `cursor` is not documented, and SDK 1.0.1 has no `cursor` (source grep: no match). The docs paginate page does not mention cursor, `next()`, `atBlock` or `for await` (fetched 2026-11-06).

Ordering: `ORDER BY type:str ASC, receivedAt:u64 DESC` -> -32001 `unexpected character` at position 59 (the comma). The docs show a single `ORDER BY attribute:type ASC|DESC`.

## E5 / N4: nonce race

Docs ([batches](https://docs.arkiv.network/writing/batches/)): "A prediction holds only while nothing else from the same account lands first." Concurrency and nonce handling are not covered. Repro `scripts/arkiv/repro/nonce-race.ts` (08:18 UTC, wallet index 1): one `predictEntityKeys`, then two concurrent `executeBatch` calls (create with the predicted salt + `ownershipChanges`) with the same prediction:

```
batch-A: LANDED tx=0xa76db1d58050f74ab6e4dd4feafde5fa0aa1ab950a67b4f051aae2343cb4cee2 created=0x86ecb212...
batch-B: FAILED EntityMutationError: Transaction failed: Execution error without revert data txHash=(none)
balance change = -127270000000000 wei   (= batch A's gas only)
```

The failing batch created nothing and moved nothing. The error text is identical to the size failure in E1, so the caller cannot tell the two causes apart.

## E10: events

Docs ([watch events](https://docs.arkiv.network/querying/watch-events/)): "Arkiv emits no event when an entity expires." (also on the expiration page); handlers listed: created, patched, extended, transferred, deleted, error, `onEvent`. No filter is documented. SDK source (`actions/public/watchEntityEvents.ts`, `WatchEntityEventsParameters`): handlers plus `pollingInterval`, no owner / creator / key filter.

## E13: expiry and calldata

Repro `scripts/arkiv/repro/expiry-history.ts` (08:19 UTC), entity `0x554e99f07de021917a0140248d33fc3f6421b85820ccca6d4fc9a72e5e517773` (60 s lifetime, created 2026-11-05):

```
arkiv_getEntity(0x554e99f07d...) -> {"result":null}
arkiv_query($key = key(...)) -> {"data":[],"blockNumber":"0x45436"}
eth_getTransactionByHash(0xaab250bc20...) -> from 0x15954bd9..., block 0x3e009, input bytes = 2820
```

The entity is gone from state and queries; the creating transaction still carries the full calldata. The [expiration page](https://docs.arkiv.network/writing/expiration/) says nothing about this. Same script: `eth_gasPrice` -> `0x3b9aca00` = 1 gwei.

## Ownership and extension (supports "What worked", and the poisoning defence)

`scripts/arkiv/repro/permissionless-extension.ts` (09:07 UTC; creator wallet 1, new owner wallet 4, stranger wallet 7). Both entities created and transferred in one batch (tx `0x83b74e94...1526` with flag, `0xfa9f1bfe...8215` without).

| Entity | Stranger `extendEntity` | Stranger `deleteEntity` | Original creator `deleteEntity` after transfer |
| --- | --- | --- | --- |
| `permissionlessExtension: true` (`$creationFlags` raw 2) | OK, tx `0xc3873991a74aabc1be7b05b72cca7b0eef1830c8e533e7b521b7d98bd9b17181` | reverts `entity 0xded8ebd7…a60dab is owned by 0x5751…8186, not 0xE1c9…c99B` | reverts `... is owned by 0x5751…8186, not 0x6Ebd…77ce` |
| no flag | reverts `... is owned by 0x5751…8186, not 0xE1c9…c99B` | reverts (same) | reverts (same) |

A shorter extension reverts: `entity 0xded8ebd7…a60dab already expires at block 285451, so extending it to 285212 would shorten its life`.

`scripts/arkiv/repro/transfer-without-consent.ts` (09:11 UTC): wallet 7 created an entity and gave it to wallet 4 in one batch (tx `0x44544d24eb8936ef68ba2592ba6e25bc92075c5199d6cc77ce3ed0de5592803c`). Query `$owner = addr(<wallet 4>)` returns it with `creator` = wallet 7. The recipient never signed. This is the evidence that `$owner` alone cannot be the trust pin and Nanite pins `$creator` (earlier text called this "untested"; it is now tested).

## Read-after-write

`scripts/arkiv/repro/read-after-write.ts` (08:19 UTC, 4 runs, polling every 100 ms after `createEntity` returns): `getEntity` visible after 225 to 308 ms with 0 misses, `arkiv_query` after 475 to 590 ms. Spike values (W4, 2026-11-05): `getEntity` 350 to 1,286 ms, query 604 to 2,218 ms. We keep polling (`waitForQueryable`) but this is not a complaint.

## Client-side SDK checks

`scripts/arkiv/repro/sdk-client-side.ts` (08:13 UTC):

- `rabdi()` -> `MissingAccessKeyError: Rabdi needs an Arkiv access key: pass it as rabdi({ accessKey }). Get a free one at https://hub.arkiv.network/access-keys, or pass accessKey: "" to use the heavily rate-limited public endpoint.` (clear and actionable; removed as an issue).
- `executeBatch` with `options: { expiration }` nested -> `InvalidExpiryError: Invalid expiry: expiration must be built with ExpirationTime, e.g. ...` (accurate; removed).
- `getEntity(key, schema)` returns columns as `{type, value}` objects; `select().from(schema)` page `skipped` is a `number`. The docs describe both ([get entity](https://docs.arkiv.network/querying/get-entity/): "Columns are read through `.value`"; [select](https://docs.arkiv.network/querying/select/): `page.skipped` counts entities that didn't fit the schema).
- `scripts/arkiv/repro/flags-typecheck.ts` passes `tsc --noEmit` with a `@ts-expect-error` on `const bad: CreationFlags = 2`, so a numeric flag is a compile error. The earlier silent no-op happened because the spike helper typed the call as `any`.
- Docs [column types](https://docs.arkiv.network/schemas/column-types/): "A bare `5n` is a `u256`, not a `u64`: write `u64(5n)`"; addresses go in `addr(...)`. Docs [query language](https://docs.arkiv.network/reference/query-language/): "`addr(0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045)` is wrapped in `addr(...)`" (unquoted) and "`ORDER BY` ... `attribute:type ASC|DESC`".

## Other checked facts

- `arkiv_getBlockTiming` -> `duration` 2 (2 s blocks).
- Live query `sh arkiv/query.curl.sh` (Alpine container, 2026-11-06): `matches 16`, `atBlock 285197`; `scripts/arkiv/repro/list-live.ts`: 11 conversation + 5 sent, 2 owners, 6 agentIds, creator only `0xa7b7...d247f`, `expiresAt` 181.9 to 182.4 days ahead (written at `max`, before the 2-day default of T3.8).
- W2 "ran out of gas" transaction `0xfc55edb8db994ce031508d6310cba967f405d5705d55557154e46e3962de2064`: receipt status 0, gasUsed 31,976 (matches the spike note). One occurrence, not reproduced, SDK message says "Send it again".

## Removed, with reason

- E3 numeric `flags`: TypeScript rejects it; only an `any` cast let it through.
- E4 bare value coercion: the docs state that bigint is `u256` and constructors are required.
- E6, E6b literal and ORDER BY syntax: documented.
- E7 response shapes: documented on the get-entity, select and JSON-RPC pages.
- E8, E9: the error messages are accurate and actionable.
- E10b: two samples, not re-run.
- E11: not reproducible as a problem.
- E14 explorer is a JS app: our scripts' limitation, not an Arkiv defect.
- E15 faucet: needs a browser, cannot be re-verified here.
- E17 out-of-gas retry: single occurrence.
- Funding delays (35 and 20 minutes in the spike notes): not reproducible and not an API issue.
