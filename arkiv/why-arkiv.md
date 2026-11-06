# Why Arkiv

**On Arkiv, each email belongs to the user's wallet, drops out of Arkiv's state at a block the chain enforces, and carries proof that our operator wrote it.**
**Once a mail is stored, our server cannot edit it, delete it or take it back. The chain enforces that, not our promise. Before a mail is stored, you have to trust us to write every mail we receive, and nothing else.**
**Swap Arkiv for Postgres and each of those guarantees turns into "trust our server".**

How it works: Nanite stores every email as one Arkiv entity, encrypted, owned by the user's wallet, with a built-in expiry. Where these guarantees stop is listed under [Honest limits](#honest-limits).

Terms used below:

- *entity*: one stored record on Arkiv.
- `$owner`: the wallet that controls the entity now.
- `$creator`: the wallet that wrote the entity. It never changes.
- `$expiresAt`: the block at which the entity drops out of Arkiv's state.
- `permissionlessExtension`: a flag that lets any wallet extend an entity's life, but not edit or delete it.
- *block*: one step of the chain. On Rabdi, one block every 2 seconds.
- *gas*: the unit a transaction's fee is counted in. On Rabdi it costs a flat 1 gwei of tGLM, the test token.
- *nonce*: a counter that goes up with each transaction from a wallet.
- *spike*: our first round of Arkiv tests, on 2026-11-05 ([W1](../docs/arkiv-spike/W1.md) to [W4](../docs/arkiv-spike/W4.md), raw data in [results/](../docs/arkiv-spike/results/)). Re-checks from 2026-11-06 are in [friction-evidence.md](friction-evidence.md).

## The test: swap Arkiv for Postgres. What would users lose?

| What the user has | On Arkiv | With Postgres | Proof |
| --- | --- | --- | --- |
| **They own their mail.** | After the hand-over, our operator's edit, delete and transfer all fail. | A `user_id` column is only our claim; we could change any row. | P1 |
| **They control delete and transfer.** | Only the owner's wallet can do it. | Only through our API, while we run it. | P1 |
| **Mail expires on a schedule.** | One-time codes leave Arkiv's state at a set block and cannot be revived. Other mail leaves at its expiry block unless a wallet pays to extend it. | A cron job, backups that keep the data, and "trust us". | P2 |
| **Readers can check who wrote it.** | `$creator` shows our operator wrote it, and fakes are dropped. | Does not apply: the database is the only writer. | P3 |
| **We can keep mail alive without touching it.** | Any wallet, including ours, can extend its life. No wallet but the owner's can edit, delete or shorten it. | We would need an "extend" endpoint with write access to the row. | P4 |
| **Anyone can read the data without us.** | One curl against the public RPC, no wallet or key. | Only through our API. | P5 |
| **The data does not depend on our server.** | The ciphertext stays on a public chain until it expires. | Gone when our database is gone. | P5 |

Proof:

- **P1:** we create each entity and hand it to the user's wallet in the same transaction. After that, our operator's edit, delete, extend and transfer all failed with `entity ... is owned by <user>, not <operator>`. The user's own edit, extend and delete worked ([W3](../docs/arkiv-spike/W3.md) tests B and C). On 2026-11-06 we re-checked with test wallets. After a transfer, the original writer could no longer delete the entity (`scripts/arkiv/repro/permissionless-extension.ts`).
- **P2:** a 60-second entity was gone from queries within about 4 s of its expiry block. After expiry, `extendEntity` and `patchEntity` both fail ([W2](../docs/arkiv-spike/W2.md) tests 1 and 1b).
- **P3:** anyone can write fake mail that looks like ours. Readers keep only mail our operator wrote. In the spike, a fake "latest one-time code" beat the real one until we filtered on `$creator` ([W4](../docs/arkiv-spike/W4.md) test 3). On 2026-11-06 we also showed that a stranger can give a victim's wallet a fake entity, so `$owner` alone is not enough (`scripts/arkiv/repro/transfer-without-consent.ts`).
- **P4:** mail (not one-time codes) is written with `permissionlessExtension`. A stranger could extend it but could not edit or delete it ([W2](../docs/arkiv-spike/W2.md) test 4, [W3](../docs/arkiv-spike/W3.md) test D). We re-checked extend and delete on 2026-11-06 (`scripts/arkiv/repro/permissionless-extension.ts`). An extension that would shorten its life fails.
- **P5:** [query.curl.sh](query.curl.sh) reads the entities straight from the public RPC, without our API. It returned 16 entities at block 285,197 on 2026-11-06.

### Where Postgres would win

Postgres is better at flexible queries (substring search, `!=`, sums and grouping, sorting by two columns), larger records, and keeping data with no 182.5-day cap. Arkiv's query language has none of those (see [friction.md](friction.md)).

That does not hurt Nanite. Every query we run is an exact match, a range or a sort on one indexed column. That is exactly what Arkiv offers.

### Cost

Writing to Arkiv is cheap and predictable: about 164k gas plus about 40 gas per byte of data ([W1](../docs/arkiv-spike/W1.md)). Gas price was re-checked on 2026-11-06.

- A typical 24.6 KiB encrypted email: 1,043,394 gas, about 0.001 tGLM.
- Keeping one email for a year (create at the maximum lifetime, then extend twice): about 1.4M gas, about 0.0014 tGLM ([W2](../docs/arkiv-spike/W2.md)).
- Our operator pays for every write and every extension. Users hold no tGLM and sign nothing to receive or keep mail.

## What we keep off Arkiv, and why

**Postgres holds only accounts, routing and bookkeeping. It never holds an email body, a plaintext private key, the plaintext seed, a signature or the recovery code** (rule in `claude/nanite-status-and-decisions.md`). Tables are in `packages/db/src/schema.ts`.

- **Accounts and keys** (`users`, `user_keys`, `sessions`, `auth_nonces`, `api_tokens`, `agents`).
  - Wallet, username, ENS name and sign-up state change during sign-up and have no value as a public, expiring record.
  - `user_keys` holds the user's public key, private key and seed. The private key and seed are each encrypted twice: once under the wallet signature and once under the recovery code. Keys must stay private, must change during recovery and rotation, and must outlive the mail. Each email's own key is different. Arkiv stores it as one sealed copy per reader (`wrappedKeys`).
  - Sign-in nonces live 5 minutes and sessions 7 days (`apps/api/src/routes/auth.ts`). Agent tokens are stored as SHA-256 hashes. All of these must be revocable at once. On a chain they would be public and cost gas per login.
  - `agents` holds sealed agent keys and must be looked up on every request. The agent's identity itself lives on ENS.
- **Routing and limits** (`mailboxes`, `domains`, `user_domains`, `send_log`).
  - Incoming mail must be routed to an agent in milliseconds, before any chain read. An address-to-agent map is not mail.
  - Custom domains mirror Resend and public DNS and change for up to 72 hours while DNS updates. They never touch Arkiv.
  - `send_log` counts daily sends with a keyed hash of the recipient, not the address. Recipients on a public chain would leak who an agent writes to.
- **Bookkeeping** (`webhook_events`, `arkiv_writes`, `audit_log`).
  - Retry records so each incoming event is handled once and each Arkiv write is never repeated. They hold pointers (entity key, tx hash), never ciphertext.
  - `audit_log` keeps agent id, endpoint, status and time, and the daily extension count. No mail data.

Also off Arkiv:

- The agent's identity, permissions, send policy, retention and signing address are ENS records on Sepolia.
- The master key and the sender-hash secret are server secrets in `.env`.

## What the user sees because of Arkiv

- "Expires in ..." on each mail is a real countdown from the chain's `$expiresAt`. "Keep" really extends the entity, and our operator pays the fee.
- The explorer link on each mail shows only ciphertext, with the user's wallet as owner.
- A one-time code drops out of Arkiv's state after 5 minutes by default (each agent can change this in ENS), whatever happens to our servers.

## Honest limits

- **Expiry is guaranteed only for one-time codes.** Other mail uses `permissionlessExtension`, so any wallet can pay to keep it alive longer. One-time codes never get the flag (`packages/arkiv/src/writer.ts` refuses it).
- **Expired data is still in chain history.** The input of the transaction that created an entity stays readable. We tested it: a 2,820-byte input from an expired entity is still returned by `eth_getTransactionByHash`. That is why content is encrypted from the first byte.
- **`$creator` proves our operator wrote a mail, not who sent it.** You have to trust our operator for what it writes, because it could insert fake mail. The planned fix is to check DKIM (the sender's mail signature). It is not built yet.
- **Delete and transfer need the user's own transaction.** It is a normal Arkiv transaction the user signs and pays a small fee for in tGLM. Users hold no tGLM by default, and the Nanite app has no delete or transfer button yet.
- **Size:** we cap each mail at 125 KiB (128,000 B) of ciphertext, keys and nonce. With our schema, 128,272 B landed and 128,400 B did not, although the docs allow 131,072 B. Our guess is that the whole transaction is capped at about 130,900 B. Arkiv has not confirmed this ([friction.md](friction.md), item 1).
- **Lifetime:** at most 182.5 days. Longer retention needs an extension (the user's Keep button or the agent's `extend_email`). A missed window loses the data.
- **Public metadata:** agent name, the owner's wallet (`ownerId`), mail type, timing, thread id, reader key ids and a per-user sender pseudonym are public. Subject, body, sender address and attachments are not.
