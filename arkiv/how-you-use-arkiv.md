# How Nanite uses Arkiv

Full attribute table, expiry table and queries: [schema.md](schema.md). Code: `packages/arkiv` (reader, writer, schema) and `apps/api/src/arkiv`. Evidence for every measured claim: [friction-evidence.md](friction-evidence.md).

## Write path

1. The inbound pipeline encrypts the mail for the user and the agent (`@nanite/crypto`). The agent's ENS records give the lifetime (`nanite.otp-ttl`, `nanite.mail-ttl`); a failed ENS read falls back to 5 minutes / 2 days.
2. The writer asks the SDK for `predictEntityKeys`, then sends **one `executeBatch`** containing `create` and `changeOwnership(user wallet)`. Result: `$creator` = operator, `$owner` = user. The user pays nothing and signs nothing.
3. A single-flight queue serializes batches (and extends) per operator account. Re-tested 2026-11-06: two concurrent batches with one prediction, one landed and one failed with `Execution error without revert data`, creating nothing. So the writer re-predicts and retries one at a time.
4. Size guard: ciphertext + wrappedKeys + nonce at most 125 KiB, else `EntityTooLargeError` before sending. Re-tested: 128,000 bytes of columns lands with our schema, 128,400 fails.

## Which filter serves which screen

| Query filter / order | Screen or API that needs it |
| --- | --- |
| `agentId = X` | Every inbox view: web inbox for one agent, `/v1/inbox`, `/v1/otp/latest`, MCP `list_inbox` |
| `ownerId = user` AND `$owner = user` | Web inbox (`GET /mail/:agentId/inbox`): "only my mail for this agent"; single-mail fetch re-checks both |
| `type = otp` (or `OR` of types) | "One-time codes" tab, `get_latest_otp`, `?type=` filter |
| `receivedAt` `ORDER BY ... DESC` | Newest first everywhere |
| `receivedAt < before` | Web inbox "load more" (stable paging) |
| `receivedAt < before` / `> after` | `/v1/inbox?before=&after=`, MCP `list_inbox` |
| `senderHash = X` | Outbound `reply-only` policy: "has this person written to this agent?" without storing their address |
| `$key = key(...)` | Open one mail; `waitForQueryable` after a write |
| `$creator = operator` (always) | Poisoning defence on every query |
| `threadId`, `keyIds` | Returned with each mail; `keyIds` is checked in the browser before decrypting. No query filters on them today (the thread index is there for a thread view or other apps) |

`countInbox` exists in the package and is covered by tests, but no screen uses it yet. The reader uses the node's own `count` projection, not client-side paging.

## Who can change each entity

| Entity | `$creator` | `$owner` | Operator can | User can | Anyone else |
| --- | --- | --- | --- | --- | --- |
| `otp` | operator | user wallet | nothing after the transfer (no `permissionlessExtension`) | patch, delete, extend, transfer | nothing |
| `conversation`, `sent` | operator | user wallet | extend only (flag `permissionlessExtension`) | patch, delete, extend, transfer | extend only (they pay gas); cannot read, edit, delete or shorten |

Tested on Rabdi on 2026-11-06 with spike wallets: [friction-evidence.md](friction-evidence.md), `scripts/arkiv/repro/permissionless-extension.ts`.

## Expiry and extension: how each type fits

| Type | Expiry | Why that fits | Extension |
| --- | --- | --- | --- |
| `otp` | 5 minutes (ENS `nanite.otp-ttl`, 1 to 60 min) | A code is useless after minutes; the chain removes it with no job of ours | Never. The writer refuses the flag, and a non-owner extend reverts |
| `conversation` | 2 days (ENS `nanite.mail-ttl`, 1 h to 4380 h) | Short default limits what stays public and costs about 9k gas more than a 1 h entity | Inbox Keep button, `POST /v1/emails/:key/extend`, MCP `extend_email` (1 to 182 days). The operator signs and pays; the new expiry is now + days and never shorter |
| `sent` | same as conversation | The copy of what an agent sent | same |

Agent extensions are gated by `nanite.extend` and a daily limit (`nanite.extend-limit`, default 20) because the operator pays. The chain maximum is 7,884,000 blocks (about 182.5 days). Expiry is exact to the block (spike W2: gone within about 4 s of `$expiresAt`); there is no expiry event (documented), so the UI counts down from `$expiresAt`.

## What each Arkiv feature means for the user

| Arkiv feature | What the user sees |
| --- | --- |
| `changeOwnership` in the create batch | The mail is in their wallet's name; the explorer shows their address as owner; they need no tGLM |
| Immutable `$creator` + pinned queries | They are never shown a forged mail, even if someone sends their wallet a look-alike entity (the spike showed a fake OTP beating the real one without the pin) |
| Entity expiry | OTP disappears after 5 minutes, mail after 2 days, unless kept; the inbox shows "expires in ..." |
| `permissionlessExtension` | The Keep button and the agent's `extend_email` work without the user signing a transaction |
| Indexed attributes | Fast "my mail", "codes only", "newest first" and reply-only checks, without scanning |
| Public reads | Anyone can run [query.curl.sh](query.curl.sh); only key holders can decrypt |

## Reads and the poisoning defence

Anyone can write entities with our schema name and attributes. In the spike (W4 test 3) an attacker wrote well-formed fake OTPs with newer `receivedAt`, and the naive "latest OTP" query returned the fake one. Adding `$creator = addr(<operator>)` returned 0 attacker rows. On 2026-11-06 we also confirmed that a third party can transfer an entity to a victim's wallet without the victim signing (`scripts/arkiv/repro/transfer-without-consent.ts`), so `$owner` alone is not a safe pin while `$creator` never changes. So:

- every query in `packages/arkiv` pins `$creator`; user views also pin `$owner` and `ownerId`;
- the reader re-checks `$creator` and the schema tag on every returned row and throws `UntrustedEntityError` otherwise (also for single-entity fetches);
- the operator address comes from config, never from chain data.

The SDK's look-alike skipping is a shape check only (W4), so it is not relied on.

## Real data

16 entities by the operator on Rabdi at block 285,197 (2026-11-06; 11 `conversation`, 5 `sent`), listed by `sh arkiv/query.curl.sh`. A few with explorer links:

| Entity | Type | Explorer |
| --- | --- | --- |
| `0xd694db84e709e1960d5559b8cd0d5610e4e6532f3e79145b561cf2f35c96658f` | conversation, read back through the agent API | [entity](https://rabdi.explorer.arkiv.network/entity/0xd694db84e709e1960d5559b8cd0d5610e4e6532f3e79145b561cf2f35c96658f) |
| `0xa63027c09116d0952b3c5f6c05b67031216573d99726c1154600e2c58b7b33a2` | conversation, decrypted with user and agent key | [entity](https://rabdi.explorer.arkiv.network/entity/0xa63027c09116d0952b3c5f6c05b67031216573d99726c1154600e2c58b7b33a2) |
| `0xc90059b537ee27a3c1ab7d19d514ba5c82957e84ab2b4428de1871e2fbaa2618` | sent copy of a real reply through Resend | [entity](https://rabdi.explorer.arkiv.network/entity/0xc90059b537ee27a3c1ab7d19d514ba5c82957e84ab2b4428de1871e2fbaa2618) |

Evidence trail: `apps/api/LIVE-E2E.md`. The explorer is a JavaScript app, so check these in a browser; the JSON-RPC query works from a terminal. The explorer entity URL pattern is taken from the SDK's explorer base and our spike notes; we could not verify it from a terminal.

Other uses of the SDK: `getEntity` for single mail, `extendEntity` for retention, `waitForQueryable` (polling) after writes (reads were visible 0.2 to 0.6 s after the receipt on 2026-11-06, up to 2.2 s in the spike).
