# Arkiv schema

Source of truth in code: `packages/arkiv/src/schema.ts` (schema `nanite.email.v1`). Chain: Rabdi testnet (chain id 7794095). SDK: `@arkiv-network/sdk` 1.0.1.

## Entities

One entity type: an encrypted email, schema tag `nanite.email.v1` (the SDK adds the attribute `arkiv.schema = "nanite.email.v1"`: 7 indexed columns + 3 bytes columns = 10 columns, plus the tag = 11 of the 32 attributes an entity may have).

- **Created by** the Nanite operator wallet (`$creator`, immutable) in one `executeBatch` that also calls `changeOwnership` to the user's wallet (`$owner`). Users pay no gas and sign nothing for mail. Three kinds of write use this one schema: inbound mail (`conversation`), inbound codes (`otp`) and the encrypted copy of every mail an agent sends (`sent`).
- **Content** is end-to-end encrypted from the moment of receipt (envelope v1, see `packages/crypto/README.md`): encrypted to the user's key and the agent's key. Plaintext columns below exist only for filtering and for deciding whether a reader can decrypt. Custom domains, sessions, tokens and wrapped keys are not on Arkiv (see [why-arkiv.md](why-arkiv.md)).
- **Size**: `ciphertext + wrappedKeys + nonce <= 125 KiB` per entity (`MAX_PAYLOAD_BYTES`). The real cap is the whole transaction (about 130.9 KB of input), not the 128 KiB of `bytes` the SDK checks: with this schema 128,000 bytes of columns landed (tx input 130,532 B) and 128,400 failed. Evidence: [friction-evidence.md](friction-evidence.md), script `scripts/arkiv/repro/size-limit.ts`. Larger mail is rejected with `EntityTooLargeError` (no chunking yet).

## Queried fields

All attributes. Everything on Arkiv is public; "why public" is the reason the field is not inside the ciphertext. "Used by" lists what in the current code actually filters or orders on it (checked in `apps/api/src` on 2026-11-06).

| Attribute | Type | Indexed | Why it is plaintext | Used by |
| --- | --- | --- | --- | --- |
| `agentId` | str (<=128 B) | yes | Every inbox query is `agentId = X`. An ENS name (`alex.user.nanitecom.eth`); can become an opaque id without a schema change. | Every read: web inbox (`GET /mail/:agentId/inbox`), agent API (`/v1/inbox`, `/v1/otp/latest`), reply-only send check |
| `ownerId` | addr | yes | Same value as the entity `$owner`, so it adds no new leak. Lets a user view be pinned on both `$owner` and `ownerId`. | Web inbox (`/mail/...`: `ownerId = user AND $owner = user`) |
| `type` | str | yes | `otp` \| `conversation` \| `sent`. Drives the retention class and the one-time-codes tab. Reveals category only. | Web "One-time codes" tab, `/v1/otp/latest`, `?type=` filters, reply-only check (`otp`/`conversation` only) |
| `receivedAt` | u64 | yes | Unix **seconds** of receipt. Inboxes are ordered and range-filtered by time; `$createdAt` is a block number and cannot be queried. | `ORDER BY receivedAt DESC` on every inbox; `before` (web paging) and `before`/`after` (`/v1/inbox`, MCP) |
| `threadId` | str | yes | Opaque id (HMAC, never the subject). Reveals thread structure and volume. | Written and returned in API responses; no Nanite query filters on it today (the index exists so a thread view or another app can) |
| `senderHash` | str (64 hex) | yes | Per-user HMAC-SHA256 blind index of the sender address (`senderHash` in `@nanite/crypto`). Enables "has this person written to this agent" without exposing the address; the key is per user and secret. | Outbound `reply-only` policy (`senderHash = X AND agentId = Y`) |
| `keyIds` | str (<=128 B) | yes | Comma-joined, sorted `keyId`s (16 hex each, max 7) of readers holding a wrapped key. A reader checks it can open the entity before decrypting; it is also bound into the AEAD associated data. Reveals who can read. | Read client-side only (web: "no key slot for you" check); not used in a filter |
| `ciphertext` | bytes | no | `0x01 \|\| XChaCha20-Poly1305(subject, body, optional raw eml)`. Encrypted. | Decrypted in the browser, or by the self-hosted agent |
| `wrappedKeys` | bytes | no | One sealed box of the content key per reader (`@nanite/crypto` wrappedKeys v1). Public-key encrypted. | Same |
| `nonce` | bytes | no | 24-byte AEAD nonce. Not secret. | Same |

System fields also used: `$creator` (pinned on every query), `$owner` (user views), `$key` (single-mail fetch and `waitForQueryable`), `$expiresAt` (countdown and the Keep button; never queried).

Metadata leak (accepted, documented): volume, timing, thread structure, reader set and a per-user sender pseudonym are visible to anyone. Subject, body, sender address and attachments are not.

## Owners

- `$creator` = the Nanite operator wallet. Never changes. **Every query pins `$creator = addr(<operator>)`**, because anyone can write look-alike entities with this schema (tested in T0.3: an attacker's fake OTP appears in unpinned queries). Pinning `$owner` alone is not enough, since an attacker can transfer a fake entity to a victim.
- `$owner` = the user's wallet (set by `changeOwnership` in the same batch). After that only the owner can patch, delete, extend or transfer; the operator cannot patch, delete or take it back.
- `permissionlessExtension` flag (immutable, set at creation): set on `conversation` and `sent`, so the operator can extend them on request (the inbox Keep button, `POST /v1/emails/:key/extend`, MCP `extend_email`) without being the owner. Tested on Rabdi: a non-owner can extend such an entity but cannot patch, delete or shorten it (`scripts/arkiv/repro/permissionless-extension.ts`, 2026-11-06). Never set on `otp`; the writer refuses it, so a code cannot be kept alive by anyone.
- Who can do what, per entity: the user (`$owner`) can patch, delete, extend and transfer; the operator (`$creator`) can only extend, and only where the flag is set; anyone else can extend flagged entities (a stranger who pays gas can keep your encrypted mail alive, not read or change it).
- Trust: the operator is trusted for what it writes (it could insert fake mail). DKIM verification is the later fix.

## Expiries

Expiry is block based (2 s blocks, maximum 7,884,000 blocks, about 182.5 days) and exact to the block (a 60 s test entity was gone within about 4 s of `$expiresAt`, spike W2); there is no expiry event (documented), so compute countdowns from `$expiresAt` (a block number; the API adds an estimated `expiresAt` ISO time and `extendable` to every mail it returns).

| Type | Expiry at write | Extension |
| --- | --- | --- |
| `otp` | 5 minutes by default (`otpTtlSeconds`); the API passes the agent's ENS `nanite.otp-ttl` (1 to 60 min) | never extendable (no `permissionlessExtension`) |
| `conversation` | 2 days by default (`DEFAULT_MAIL_TTL_SECONDS`); the API passes the agent's ENS `nanite.mail-ttl` (1 h to 4380 h) | `extendEmail(key, {expiresIn})` sets a new expiry from now (never shorter); works for the operator because of `permissionlessExtension` |
| `sent` | same as conversation | same as conversation |

`writeEmail({ expiresIn })` overrides the policy (seconds, or `'max'`). Since T3.8 nothing is written at `max` by default; mail is kept longer on request (`POST /v1/emails/:key/extend`, MCP `extend_email`, the inbox Keep button; 1 to 182 days). `extendEmail` returns `expiresAtBlock` from the engine's `ExpiryExtended` event. The extend call is queued behind writes in the same single-flight queue and costs the operator gas.

## Queries used

Rendered by the SDK builder (`reader.buildInboxQuery(...)`); `ORDER BY` needs the type tag (`receivedAt:u64`). Literals: `str('x')`, `u64(5)`, unquoted `addr(0x...)` and `key(0x...)`.

```
# listInbox({ agentId })       (limit/offset sent as RPC options, max limit 100)
arkiv.schema = str('nanite.email.v1') AND agentId = str('<agent>') AND $creator = addr(<operator>) ORDER BY receivedAt:u64 DESC

# listInbox with every filter
arkiv.schema = str('nanite.email.v1') AND $creator = addr(<operator>) AND $owner = addr(<user>) AND agentId = str('<agent>') AND ownerId = addr(<user>) AND (type = str('otp') OR type = str('sent')) AND receivedAt < u64(<before>) AND receivedAt > u64(<after>) ORDER BY receivedAt:u64 DESC

# latestOtp(agentId): the same with type = str('otp'), limit 1
# countInbox: the same filters through count (no ORDER BY)
# getEmail(key): arkiv_getEntity, then checks $creator == operator and the schema tag
# waitForQueryable(key): ... AND $key = key(<entityKey>) AND $creator = addr(<operator>), polled
```

Paging uses `limit` + `offset` (the SDK has no cursor in 1.0.1, although the raw RPC returns one: see [friction.md](friction.md)); the reader's cursor is the opaque offset. Offsets shift if mail arrives between pages; the web inbox therefore pages with `before` (the last `receivedAt`), and `receivedAt` ties within one second can repeat or skip a row at a page boundary.

Query-language limits that shape these queries (all verified on 2026-11-06, details in [friction-evidence.md](friction-evidence.md)): no negation (`!=` and `NOT` fail, so types are listed with `OR`), only prefix (`STARTSWITH`) and exact string matches, no arithmetic or `now()` (the caller computes `before`/`after`), one `ORDER BY` key, and a node-side total `count` but no other aggregate.

## Runnable query

One curl against the public JSON-RPC endpoint, no wallet or SDK needed. The script [`arkiv/query.curl.sh`](query.curl.sh) wraps it (POSIX `sh`, needs `curl` and `jq`; run `sh arkiv/query.curl.sh`; `AGENT`, `OPERATOR`, `LIMIT`, `RPC` are optional env vars). The default `OPERATOR` is the Arkiv-side operator (`docs/wallets.md`, Arkiv index 3), the `$creator` of the live-test entities below. Those entities were written with `ExpirationTime.max()`, so they stay queryable until about May 2027.
```bash
RPC=https://rpc.rabdi.db-chain.testnet.arkiv.network
OPERATOR=0xA7B7EbE69F1bcb3ACD680d5e06cE640E0D2D247F   # $creator pin: always include it
curl -sS -X POST "$RPC" -H 'content-type: application/json' -d "{
  \"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"arkiv_query\",
  \"params\":[\"arkiv.schema = str('nanite.email.v1') AND \$creator = addr($OPERATOR) ORDER BY receivedAt:u64 DESC\",
  {\"select\":{\"key\":true,\"owner\":true,\"creator\":true,\"expiresAt\":true,\"count\":true,
    \"attributes\":{\"agentId\":true,\"type\":true,\"receivedAt\":true,\"threadId\":true,\"keyIds\":true}},\"limit\":\"0x5\"}]}" | jq '.result.data[] | {key, owner, creator}'
```

Selecting named attributes leaves out `ciphertext`, `wrappedKeys` and `nonce`. Numbers in the raw response (`count`, `blockNumber`, `expiresAt`, `u64` values) are hex strings. Without curl or jq on your machine, run it in a throwaway Alpine container (nothing is installed on the host or in the `tools` image; tested with busybox `sh`):

```bash
docker run --rm -v "$PWD/arkiv:/w:ro" alpine:3.20 sh -c 'apk add -q curl jq && sh /w/query.curl.sh'
```

Output of `sh arkiv/query.curl.sh` (run in Docker on 2026-11-06, ciphertext never shown; the first of 5 rows requested):

```json
{ "matches": 16, "atBlock": 285197,
  "entities": [ {
      "key": "0x8e33571582dde00edbc3397e81f7a0dc7925a1a37cf2149f9450259b1632c528",
      "owner": "0xfad31e74f1cb69046bbb2e4a15ce653bee6936c0",
      "creator": "0xa7b7ebe69f1bcb3acd680d5e06ce640e0d2d247f",
      "expiresAtBlock": 8165275,
      "agentId": "kit.nanitedemo.nanitecom.eth", "type": "sent",
      "receivedAt": "2026-11-06T06:58:28Z", "threadId": "5c6a0469cddd486291b95ba38018a377",
      "senderHash": "70babf24cb0b...", "keyIds": "72820b9a4bdf78ce,946c5ae89873ac79" }, ... ] }
```

`owner` (the user wallet) differs from `creator` (the operator): that is the create-and-transfer batch. `expiresAtBlock` 8,165,275 against `atBlock` 285,197 is about 182 days. At that moment the operator had 16 live entities (11 `conversation`, 5 `sent`, 2 owner wallets, 6 agent names); they were written at the maximum lifetime during testing, before the 2-day default, so they stay queryable until about May 2027 (`scripts/arkiv/repro/list-live.ts`). New mail written with the current defaults appears with `expiresAtBlock` about 86,400 blocks ahead (2 days) and OTPs vanish after 5 minutes, so the count changes over time.
