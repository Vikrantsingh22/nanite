# @nanite/api

Local-development backend: Hono on `@hono/node-server`, TypeScript strict, ESM, run with `tsx`. Uses `@nanite/db` (consumed as TS source). Deployment files are out of scope here (T4.3).

## Endpoints

| Route | Response |
| --- | --- |
| `GET /` | `{"service":"nanite-api"}` |
| `GET /health` | `{"ok":true,"db":"up","version":"0.0.1"}`; `503` with `{"ok":false,"db":"down",...}` when `select 1` fails (3 s timeout) |
| anything else | `404 {"error":"not_found"}` |
| unhandled error | `500 {"error":"internal_error","requestId":"..."}` (message never echoed) |

## Inbound mail (T1.3, inbound half)

`POST /webhooks/resend` (503 until `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SENDER_HASH_SECRET` are set; the API boots without them).

Flow: raw body -> Svix signature check (HMAC-SHA256 over `id.timestamp.rawBody`, constant-time, 5 min tolerance; 401 with no detail) -> `recordWebhookEvent` dedupe on the Svix id (a replay of a `stored`/`dropped`/in-flight event answers `200 {"status":"duplicate"}`; a `failed` or abandoned `processing` event is re-claimed atomically, which is how Resend retries succeed) -> `findMailboxByAddress` for every recipient; unknown/disabled/revoked-agent mailboxes are marked `dropped` and answered 200 BEFORE any content is fetched -> `fetchReceived` -> classify (`otp` vs `conversation`) -> encrypt to user + agent -> `ArkivWriterPort.writeEmail` (real `@nanite/arkiv/writer`, schema `nanite.email.v1`) -> event `stored` with the entity key(s). Errors mark the event `failed` with a fixed code (`internal_error`, `no_user_key`, `provider_http_502`, ...) and answer 500 so Resend retries. Other event types answer `200 {"status":"ignored"}`.

- Payload shapes and doc links: `src/mail/resend.ts`. Signature scheme: `src/mail/svix.ts`. Provider interface: `src/mail/provider.ts` (`MailProvider`).
- Classification (`src/inbound/classify.ts`): `otp` if an OTP keyword (verification, one-time, passcode, security code, ...) appears in subject/body AND a 4-8 digit code is found (and body < 2000 chars); else `conversation`. Links come from `href`s and bare URLs (max 20).
- Live run and demo seed: see [LIVE-E2E.md](LIVE-E2E.md) (`scripts/live-e2e.ts` drives the real API end to end; `scripts/seed-demo.ts` seeds a demo user with 2 agents and 5 fake emails, idempotent). Fake fixtures for `FAKE_RESEND_CONTENT=1`: `scripts/send-fake-webhook.ts [address] [--fixture=conv|otp|newsletter|receipt|otp2]`.
- Structured agent fields `{otp?, links[], from?, messageId?, references?}` (sender address, Message-ID and References only here, never in plaintext attributes, Postgres or logs) travel inside the encrypted payload as `PlainEmail.meta` (`@nanite/crypto`, flags bit1). `rawEml` stays reserved for the real raw .eml. Never plaintext attributes.
- `threadId` = first 32 hex of HMAC-SHA256(HMAC-SHA256(SENDER_HASH_SECRET, "nanite/thread-id/v1/user/<userId>"), normalized thread root), where the root is the first `References` id, else `In-Reply-To`, else the mail's own `Message-ID`, else the provider email id. Opaque, per user, stable across replies.
- `senderHash` = `@nanite/crypto` `senderHash(SENDER_HASH_SECRET, userId, from)`; the sender address is not stored or logged.
- Entity (`nanite.email.v1`): `agentId` = `agents.ens_name`, `ownerId` / `$owner` = user wallet (lowercase), `keyIds` = sorted recipient keyIds from `encryptEmail`, `permissionlessExtension = type !== "otp"`; OTPs expire after 5 minutes, conversations get the chain maximum.
- Writes are synchronous inside the request with per-recipient idempotency (no async outbox, no ciphertext in Postgres). `arkiv_writes` has one row per (webhook event, mailbox): `submitted` -> `confirmed` (entity key + tx hash) or `failed` (fixed code: `arkiv_write_failed`, `entity_too_large`, `invalid_fields`, `internal_error`). On a retry a `confirmed` recipient is skipped and its entity key reused; the event becomes `stored` only when every recipient is confirmed. Known gap: a crash between the chain write and the `confirmed` update leaves a `submitted` row, and the retry would write that recipient again (duplicate entity, no data loss).
- One shared `createArkivWriter` per process (`src/arkiv/arkiv-writer.ts`, single-flight queue). Without `ARKIV_OPERATOR_PRIVATE_KEY` the API falls back to `InMemoryArkivWriter` and logs one warning at boot (never the key).
- Dev: `FAKE_RESEND_CONTENT=1` serves canned content (OTP if the email id contains `otp`); `scripts/provision-dev-keys.ts` gives the seeded vikrant/alex real public keys (the tests do this too, overwriting the seed's placeholder keys); `scripts/send-fake-webhook.ts [address] [--otp]` signs and POSTs a sample event; `scripts/arkiv-dev-key.ts [--dev-flags]` writes missing `ARKIV_OPERATOR_PRIVATE_KEY` (from `ARKIV_TEST_MNEMONIC` index 3), `RESEND_WEBHOOK_SECRET` and `SENDER_HASH_SECRET` into `.env` (never overwrites, prints the operator address only); `--dev-flags` also adds `DEV_ROUTES=1` and `FAKE_RESEND_CONTENT=1` (remove them for real Resend mail). The `api` compose service loads `.env` (optional).
- DEV ONLY `GET /internal/dev/inbox/:agentEns`: mounted only when `NODE_ENV !== "production"`, `DEV_ROUTES=1` and the real writer is configured. Returns Arkiv metadata (`key`, `type`, `receivedAt`, `$owner`, `$creator`, `$expiresAt`), never ciphertext or decrypted content.
- Live check (opt-in, writes on Rabdi, run it alone): `docker compose run --rm tools npm run test:live -w apps/api`. Results are appended to `LIVE-CHECK.md`.

## Env (validated at start, process exits with a clear message if bad)

| Var | Default |
| --- | --- |
| `PORT` | `4000` |
| `DATABASE_URL` | required (compose: `postgres://nanite:nanite@db:5432/nanite`) |
| `WEB_ORIGIN` | `http://localhost:3000` (only origin CORS allows, credentials on) |
| `RESEND_API_KEY` | optional; Receiving/Send API key |
| `RESEND_WEBHOOK_SECRET` | optional; `whsec_<base64>` from the Resend webhook page |
| `SENDER_HASH_SECRET` | optional; >= 16 chars; keys `senderHash` and `threadId` |
| `ARKIV_OPERATOR_PRIVATE_KEY` | optional; `0x` + 64 hex; real Arkiv writer when set, in-memory fake otherwise |
| `ARKIV_ACCESS_KEY` | optional; Arkiv RPC rate-limit key |
| `DEV_ROUTES` | dev only; `1` mounts `/internal/dev/*` (ignored when `NODE_ENV=production`) |
| `FAKE_RESEND_CONTENT` | dev only; `1` serves canned email content (ignored when `NODE_ENV=production`) |

## Structure

- `src/index.ts` bootstrap + graceful shutdown (SIGTERM/SIGINT: stop server, close db)
- `src/app.ts` `createApp(deps)` (deps: `db.ping`, `webOrigin`, `version`, `log`), middleware: request id (`x-request-id`), access log, secure headers, CORS, JSON 404/500
- `src/env.ts` env validation
- `src/routes/*.ts` route groups, mounted in `createApp` (add new routes there)

## Logging rule

The access log prints method, path (no query string), status, duration, request id as one JSON line. It never reads headers or bodies. Keep it that way: email content will pass through this service. Tests: `test/app.test.ts`, and `test/inbound.test.ts` (subject, body, sender address and OTP code absent from all logs and `webhook_events` rows). The inbound pipeline logs only `{event, outcome, eventId, type, entities, code}`.

## Commands (all in Docker)

```
docker compose up -d db api                       # migrates, then tsx watch on 127.0.0.1:4000
docker compose run --rm tools curl -s http://api:4000/health
docker compose run --rm tools npm run test -w apps/api      # needs db up
docker compose run --rm tools npm run typecheck -w apps/api
```
