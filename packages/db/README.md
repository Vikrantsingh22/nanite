# @nanite/db

Operational Postgres schema (Drizzle ORM, `postgres` driver) for Nanite. Postgres 17.6. The database is meant to be rebuildable from Arkiv, ENS and the recovery code.

## Tables

| Table | Purpose |
| --- | --- |
| `users` | Wallet (lowercase, unique), username (ENS-label-safe, unique), ENS name, resumable onboarding state |
| `user_keys` | Public key, key id, wallet- and recovery-wrapped private key and seed (ciphertext), salts, passphrase mode, key version. One row per user |
| `domains` | Mail domains: owner (null = shared demo domain), name, Resend domain id, verification status, DNS records (jsonb) |
| `agents` | Per-user agents: label, derivation index (unique per user), wallet, ENS name, resolver, public key, custody, `encrypted_private_key` (only for `custody = nanite`, under the master key; check constraint forbids a key when `self`), `revoked_at` |
| `mailboxes` | Routing table, hit on every inbound email: lowercase `address` (unique index) to domain, user, agent, status |
| `api_tokens` | Agent API tokens, stored as hash only, with label, last used, expiry, revoked |
| `webhook_events` | Dedupe and replay: `(provider, provider_event_id)` unique, Resend email id, status, Arkiv entity key, error, attempts |
| `arkiv_writes` | Write ledger for operator Arkiv writes: kind (email/sent/extend), status (queued/submitted/confirmed/failed), entity key, tx hash, attempts, last error (fixed non-content code), `payload_ref` pointer; inbound rows also carry `webhook_event_id` + `mailbox_id` (FKs, nullable for other kinds) with `UNIQUE(webhook_event_id, mailbox_id)` so a retry never rewrites an already-confirmed recipient (migration `0001_fancy_the_initiative`). No ciphertext or plaintext |
| `send_log` | Outbound audit: agent, `recipient_hash`, policy decision, policy snapshot (ENS records read, jsonb), provider message id |
| `auth_nonces` | SIWE nonces (unique, expiry, used_at) |
| `sessions` | Server sessions (random uuid id, expiry, revoked_at) |
| `audit_log` | Agent, endpoint, status code, time. Never bodies |

All tables: snake_case, uuid PKs (`gen_random_uuid()`), `timestamptz` timestamps. Wallet addresses are stored lowercase (checked); display checksummed in the UI.

`send_log.recipient_hash` is `hex(HMAC-SHA256(recipient address lowercased, server secret))`. It supports per-recipient counting (rate limits, reply-only checks) without storing addresses. The secret is env/KMS only.

## Never stored in Postgres

Email bodies, subjects, headers or raw mail; plaintext private keys; the plaintext Nanite seed; wallet signatures; recovery codes; the master key; the sender-hash/HMAC secret; recipient addresses in clear. Key material exists only as ciphertext (`user_keys.wrapped_*`, `agents.encrypted_private_key`).

## Usage

```ts
import { createDb, findMailboxByAddress, recordWebhookEvent } from "@nanite/db";

const { db, close } = createDb(process.env.DATABASE_URL!);
const route = await findMailboxByAddress(db, "Alex@Nanite.test"); // null if unknown
const { event, created } = await recordWebhookEvent(db, {
  provider: "resend",
  providerEventId: "evt_123",
  resendEmailId: "em_123",
}); // created=false on a duplicate delivery
```

Env: `DATABASE_URL` (compose default `postgres://nanite:nanite@db:5432/nanite`), `SHARED_MAIL_DOMAIN` (seed only, default `nanite.test`).

## Commands (all in Docker)

```
docker compose up -d db
docker compose run --rm tools npm run db:migrate          # apply migrations/ to DATABASE_URL
docker compose run --rm tools npm run db:seed             # idempotent demo user, domain, agent alex, mailbox
docker compose run --rm tools npm run generate -w packages/db   # new migration after editing src/schema.ts
docker compose run --rm tools npm run test -w packages/db       # uses a separate database `nanite_test` (created and reset automatically)
docker compose run --rm tools npm run typecheck -w packages/db
```

Migrations are generated SQL in `migrations/` and are committed. Never edit an applied migration; generate a new one.
