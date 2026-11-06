# Live end-to-end runs

First live run of the whole product through the real HTTP API, on 2026-11-05/06 (J1): real Sepolia (ENSv2) and real Arkiv (Rabdi) writes, no real email (inbound = signed fake Resend webhook with canned content, outbound = `FAKE_RESEND_SEND=1`). Everything is driven as the test user wallet by `apps/api/scripts/live-e2e.ts`, which uses the same `@nanite/crypto` helpers as the browser (`prepareKeys`, `unlockWithBundle`, `deriveAgentWallet`, `decryptEmail`) and the same SIWE message as `apps/web/src/lib/session-context.tsx`. The script prints only step results, tx hashes, entity keys and addresses (no keys, tokens, cookies or email content) and appends a section per run below.

**Result: all steps a to j passed** (run 2 below). Run 1 got through a to f4 and stopped at g because my raw `arkiv_query` asked for a `payload` field the node does not have (script bug, fixed); run 2 resumed with the same user/agent and passed everything.

## How to run

```
# 1. API needs: FAKE_RESEND_CONTENT=1, FAKE_RESEND_SEND=1, DEV_ROUTES=1 (optional), NANITE_MASTER_KEY, OPERATOR_PRIVATE_KEY,
#    ARKIV_OPERATOR_PRIVATE_KEY, SENDER_HASH_SECRET, RESEND_WEBHOOK_SECRET, SEPOLIA_RPC_URL  (all in the local .env)
docker compose up -d db api
# 2. run it (new username on a fresh database, otherwise it resumes the wallet's existing user)
docker compose run --rm tools npx tsx apps/api/scripts/live-e2e.ts [--username=e2eabc12] [--api=http://api:4000]
```

Since the async webhook (N1) the live scripts need the API to run with `WEBHOOK_SYNC=1` (add `-e WEBHOOK_SYNC=1` to the `docker compose run ... api` commands below, or set it in `.env`), otherwise the webhook answers `{"status":"accepted"}` before the Arkiv write and the scripts' `stored` check fails. With real Resend leave it unset.

Real Resend (`apps/api/scripts/live-resend.ts`, see docs/resend-integration.md section 5c): `--create-domain` / `--verify` / `--check` administer the domain through the Resend API; `--send-test --to=<addr>` sends one real mail from `alex` through `/v1/emails/send` (start the second API WITHOUT `FAKE_RESEND_SEND`, with `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SHARED_MAIL_DOMAIN`; the script rotates alex's token in memory and prints the provider id and signature result); `--wait-inbound --agent=<id>` polls the user inbox as the test wallet until a new real mail arrives and prints booleans (subject present, from present, otp detected).

Steps: a SIWE sign-in, b keys (generate in memory, or unlock the stored bundle with the wallet signature on a resume), c username claim (poll to done, then complete), d add agent 0 (wallet derived from the seed, poll to active), e ENS resolution through UniversalResolverV2 (addr, email, send policy) plus `getAgentPermissions`, f inbound conversation and OTP through the fake webhook, user inbox decrypted client-side, `/v1` decrypt with the agent token, g raw `arkiv_query` per entity (owner = user, creator = Arkiv operator, none of 10 plaintext needles in the raw response), h outbound policy (reply-only default, stranger 403, `PUT send-policy` allowlist on chain, stranger 200, sent copies decrypt), j OTP expiry (poll the raw query until the entity is gone), i revoke (token 401, ENS write roles gone). The script stops if the ENS operator balance is below 0.05 ETH (it was 0.5000 ETH before and after: Sepolia gas was negligible).

## Databases (important)

The test user wallet `0xfAD3...36C0` is already bound to the placeholder `vikrant` row that `npm run db:seed` and the API tests create in the dev database `nanite` (dummy wrapped keys; the tests also assert that wallet). A real onboarding for the same wallet cannot coexist with it (`users.wallet_address` is unique, and the keys are placeholders). So the live runs use a separate database `nanite_live` in the same Postgres and a second API process:

```
docker compose exec -T db psql -U nanite -d postgres -c "create database nanite_live"
docker compose run --rm -e DATABASE_URL=postgres://nanite:nanite@db:5432/nanite_live tools npm run db:migrate
docker compose run -d --no-deps --name nanite-api-live -e DATABASE_URL=postgres://nanite:nanite@db:5432/nanite_live -e PORT=4000 api npm run start -w apps/api
docker compose run --rm -e API_URL=http://nanite-api-live:4000 tools npx tsx apps/api/scripts/live-e2e.ts
docker rm -f nanite-api-live        # when done
```

For a fresh username: `drop database nanite_live; create database nanite_live;` and migrate again (the wallet can own many names on chain; the API allows one username per wallet per database). To show the live data in the web app, run that second API on port 4000 in place of the dev `api` (`NEXT_PUBLIC_API_BASE_URL` points at `http://localhost:4000`).

## Demo seed (T4.1)

`apps/api/scripts/seed-demo.ts` seeds a demo user through the same API path: wallet sign-in, keys, username `nanitedemo` (override `--username=`), two agents (`alex`, `scout`, real Sepolia txs only for what is missing) and five invented inbound emails through the fake webhook (real Arkiv writes): alex gets a conversation (Dana Whitfield, links) and an OTP (Acme, 482913); scout gets a newsletter (Orbit Weekly, HTML with remote images), a billing receipt and an OTP (Northwind, 731540). It is idempotent: it detects what already exists by decrypting the inbox, and a re-run sends nothing new except OTPs whose 5-minute entity has expired (so run it right before a demo). It never prints tokens; rotate an agent token from the dashboard when needed.

```
docker compose run --rm -e API_URL=http://nanite-api-live:4000 tools npx tsx apps/api/scripts/seed-demo.ts
```

Seed run on a fresh `nanite_live` database (2026-11-06): `nanitedemo.nanitecom.eth`, agents `alex.nanitedemo.nanitecom.eth` (`0xa3b8...f8a2`) and `scout.nanitedemo.nanitecom.eth` (`0x90b3...5268`), 5 emails, ids below. A second run changed nothing ("already in the inbox, skipped" x5).

- alex conversation: [`0xeddcc0321020504bba2f52011592a8f55689b8da6f8d07ca72584c6445289338`](https://rabdi.explorer.arkiv.network/entity/0xeddcc0321020504bba2f52011592a8f55689b8da6f8d07ca72584c6445289338)
- alex OTP: [`0xd158f8d1170e9482170af2d3a328b23df60e6ca65973db87cb3dd60174768b5b`](https://rabdi.explorer.arkiv.network/entity/0xd158f8d1170e9482170af2d3a328b23df60e6ca65973db87cb3dd60174768b5b) (expired 5 minutes after the write, by design)
- scout newsletter: [`0xf522864ca75ebe862574aeca4a64bc891565e9bbba8bf2c282a30f63b5789f7a`](https://rabdi.explorer.arkiv.network/entity/0xf522864ca75ebe862574aeca4a64bc891565e9bbba8bf2c282a30f63b5789f7a)
- scout receipt: [`0x940740b3eb00c18a233f1ad7a8b4046cbce8dd53caa63a2e1a3eb397c765a988`](https://rabdi.explorer.arkiv.network/entity/0x940740b3eb00c18a233f1ad7a8b4046cbce8dd53caa63a2e1a3eb397c765a988)
- scout OTP: [`0xfb458a7ae296f93755ce4e4ded0b808a4b60ef7f5a34d0d9d503e7957e722bc8`](https://rabdi.explorer.arkiv.network/entity/0xfb458a7ae296f93755ce4e4ded0b808a4b60ef7f5a34d0d9d503e7957e722bc8) (expired)

## Signing check (option B)

`apps/api/scripts/live-signer.ts` publishes/rotates the demo agent's `nanite.signer`, sends one mail through the fake provider and verifies it with `verify-mail-signature.ts` against LIVE ENS (also with a tampered subject, which must fail). The live API container needs `FAKE_RESEND_SEND=1` and `DEV_ROUTES=1` in addition to the usual flags (`GET /internal/dev/outbox` returns only From and headers of fake sends). It rotates `alex`'s API token (the old one stops working) and stops if the operator balance is below 0.05 ETH. The migration for the signer columns must be applied to `nanite_live` first.

```
docker compose run --rm -e DATABASE_URL=postgres://nanite:nanite@db:5432/nanite_live tools npm run db:migrate
docker compose run -d --no-deps --name nanite-api-live -e DATABASE_URL=postgres://nanite:nanite@db:5432/nanite_live -e PORT=4000 -e FAKE_RESEND_SEND=1 -e FAKE_RESEND_CONTENT=1 -e DEV_ROUTES=1 api npm run start -w apps/api
docker compose run --rm -e API_URL=http://nanite-api-live:4000 tools npx tsx apps/api/scripts/live-signer.ts
docker rm -f nanite-api-live
```

Result (2026-11-06): see the last section of this file. Signer `0x6f8C33d4184d115325b4DaFA58F0F7EE516877fa` for `alex.nanitedemo.nanitecom.eth`, publish tx `0x32388b6d03cdea0d36fd36db5828608dc8a8f08c092a9b221820c23ffc05d611`, verifier verdict `valid: true`.

## Findings

- OTP expiry is exact to the block: the entity was returned at block 262867 and gone at block 262869, the block equal to its `expiresAt` (262869). After that it was also absent from the user inbox (`type=otp`) and `/v1/otp/latest` answered 404, while the conversation entity (expires block 8,146,716, about 182 days) stayed.
- Inbound HTML is not stored: the pipeline encrypts `text` (or `htmlToText(html)` when there is no text part), so the sandboxed-iframe path in the inbox is only reachable with HTML-looking bodies; real newsletters (which carry a text part, or are stripped to text) show as text and the "remote images blocked" counter stays at 0. The seed's newsletter therefore demonstrates link extraction, not the iframe. Storing the HTML part would need a decision (size, agent prompt-injection surface).
- The `reply-only` default worked end to end: the reply to the inbound sender was allowed because the blind index of the recipient matched the stored `senderHash` of the earlier mail, the stranger got `403 policy_reply_only`.
- Outbound threading: `inReplyTo` sets `In-Reply-To`/`References` from the encrypted `meta.messageId`/`meta.references` (see README).
- The shared `onboarding-crypto` code moved into `@nanite/crypto` (`onboarding.ts`) so scripts and the browser run identical code; the web file re-exports it.

## Run 2026-11-05T20:36:45.936Z (FAILED)

- Username: `e2e0aneq` -> `e2e0aneq.nanitecom.eth`; agent `alex.e2e0aneq.nanitecom.eth`, mailbox `alex.e2e0aneq@nanite.test`, agent wallet `0xd1150dff44f40ce8a2e3bf03d128abf7b3fb8b3f`
- Test user wallet `0xfAD31e74F1Cb69046BBB2e4A15ce653beE6936C0`; ENS operator `0x38CbFe210ce51A97fE698982952412AB12ad3dab` (balance 0.5000 -> 0.5000 ETH); Arkiv operator `0xA7B7EbE69F1bcb3ACD680d5e06cE640E0D2D247F`.
- API `http://nanite-api-live:4000`; inbound via the signed fake Resend webhook, outbound via FAKE_RESEND_SEND (no real email).

| step | result | time | detail |
| --- | --- | --- | --- |
| 0 preflight | pass | 0.5s | api up; ENS operator 0x38CbFe210ce51A97fE698982952412AB12ad3dab has 0.5000 ETH; arkiv operator 0xA7B7EbE69F1bcb3ACD680d5e06cE640E0D2D247F; user 0xfAD31e74F1Cb69046BBB2e4A15ce653beE6936C0 |
| a SIWE sign-in | pass | 0.1s | session cookie set; onboardingState=started hasKeys=false username=- |
| b keys | pass | 0.1s | generated in memory and POSTed (public key + wrapped blobs only); keyId dba30c2f06b85bbf |
| c username | pass | 57.7s | e2e0aneq.nanitecom.eth claimed; onboarding done; txs: deploy-registry 0x9b08c6d5942c62cd0322cfb8bb7f86acb3158d27f2ebef7da48b78397ae2c030, set-parent 0xf506dc33e94670649ed887e7bdc02a083c68ed3eb85b23fbc31dd8676560f00e, register-username 0xcae839a92653f46e70a839809a32eeec84f2a7561f36cd5b18c99de076c1e0b8 |
| d agent | pass | 57.4s | alex.e2e0aneq.nanitecom.eth active (index 0), email alex.e2e0aneq@nanite.test, wallet 0xd1150dff44f40ce8a2e3bf03d128abf7b3fb8b3f, created; txs: deploy-resolver 0x40002378f275f685844a460b7bc2d6488722cbe47caf266a762b114491e6a241, register-agent 0xf4859a350119d284d44d69aef152677815aaa13d7085aeb4685550ed2deafc7c, grant-keys 0xbd5106c95f45121cc5a36e7df843acd1e14f3924bc9acead0c566161ec189df8 |
| e ENS resolve | pass | 5.6s | addr 0xd1150DfF44F40CE8a2E3bf03D128ABF7b3fb8B3f email alex.e2e0aneq@nanite.test policy=reply-only limit=50 allow=0; agent may write only [agent-context] |
| f1 inbound conversation | pass | 8.0s | webhook 200 {"status":"stored"} |
| f2 inbound otp | pass | 7.8s | webhook 200 {"status":"stored"}; arkiv block 262691 |
| f3 user inbox + client-side decrypt | pass | 0.7s | conv 0xaf563499ffbc334211945bd62abfad46ff70f12175457c681273e97bb75a156a, otp 0x7fc4df23ad5a173b99c63872b18bd4d19f14ecfdbb1451960814c275b36773e6 |
| f4 agent API (/v1) decrypt | pass | 1.0s | agent token decrypts conversation and latest OTP; bad token rejected |
| g arkiv raw query | **FAIL** | 0.3s | arkiv_query error: invalid options param: ErrorObject { code: InvalidParams, message: "Invalid params", data: Some(RawValue("unknown field `payload`, expected one of `key`, `owner |

Sepolia transactions:

- username: deploy-registry: [`0x9b08c6d5942c62cd0322cfb8bb7f86acb3158d27f2ebef7da48b78397ae2c030`](https://sepolia.etherscan.io/tx/0x9b08c6d5942c62cd0322cfb8bb7f86acb3158d27f2ebef7da48b78397ae2c030)
- username: set-parent: [`0xf506dc33e94670649ed887e7bdc02a083c68ed3eb85b23fbc31dd8676560f00e`](https://sepolia.etherscan.io/tx/0xf506dc33e94670649ed887e7bdc02a083c68ed3eb85b23fbc31dd8676560f00e)
- username: register-username: [`0xcae839a92653f46e70a839809a32eeec84f2a7561f36cd5b18c99de076c1e0b8`](https://sepolia.etherscan.io/tx/0xcae839a92653f46e70a839809a32eeec84f2a7561f36cd5b18c99de076c1e0b8)
- agent: deploy-resolver: [`0x40002378f275f685844a460b7bc2d6488722cbe47caf266a762b114491e6a241`](https://sepolia.etherscan.io/tx/0x40002378f275f685844a460b7bc2d6488722cbe47caf266a762b114491e6a241)
- agent: register-agent: [`0xf4859a350119d284d44d69aef152677815aaa13d7085aeb4685550ed2deafc7c`](https://sepolia.etherscan.io/tx/0xf4859a350119d284d44d69aef152677815aaa13d7085aeb4685550ed2deafc7c)
- agent: grant-keys: [`0xbd5106c95f45121cc5a36e7df843acd1e14f3924bc9acead0c566161ec189df8`](https://sepolia.etherscan.io/tx/0xbd5106c95f45121cc5a36e7df843acd1e14f3924bc9acead0c566161ec189df8)

Arkiv entities (ciphertext only; owner = user wallet, creator = Arkiv operator):

- conversation (inbound): [`0xaf563499ffbc334211945bd62abfad46ff70f12175457c681273e97bb75a156a`](https://rabdi.explorer.arkiv.network/entity/0xaf563499ffbc334211945bd62abfad46ff70f12175457c681273e97bb75a156a)
- otp (inbound): [`0x7fc4df23ad5a173b99c63872b18bd4d19f14ecfdbb1451960814c275b36773e6`](https://rabdi.explorer.arkiv.network/entity/0x7fc4df23ad5a173b99c63872b18bd4d19f14ecfdbb1451960814c275b36773e6)

Failures:

- g arkiv raw query: arkiv_query error: invalid options param: ErrorObject { code: InvalidParams, message: "Invalid params", data: Some(RawValue("unknown field `payload`, expected one of `key`, `owner

## Run 2026-11-05T20:39:39.148Z (all steps passed)

- Username: `e2e0aneq` -> `e2e0aneq.nanitecom.eth`; agent `alex.e2e0aneq.nanitecom.eth`, mailbox `alex.e2e0aneq@nanite.test`, agent wallet `0xd1150dff44f40ce8a2e3bf03d128abf7b3fb8b3f`
- Test user wallet `0xfAD31e74F1Cb69046BBB2e4A15ce653beE6936C0`; ENS operator `0x38CbFe210ce51A97fE698982952412AB12ad3dab` (balance 0.5000 -> 0.5000 ETH); Arkiv operator `0xA7B7EbE69F1bcb3ACD680d5e06cE640E0D2D247F`.
- API `http://nanite-api-live:4000`; inbound via the signed fake Resend webhook, outbound via FAKE_RESEND_SEND (no real email).

| step | result | time | detail |
| --- | --- | --- | --- |
| 0 preflight | pass | 0.4s | api up; ENS operator 0x38CbFe210ce51A97fE698982952412AB12ad3dab has 0.5000 ETH; arkiv operator 0xA7B7EbE69F1bcb3ACD680d5e06cE640E0D2D247F; user 0xfAD31e74F1Cb69046BBB2e4A15ce653beE6936C0 |
| a SIWE sign-in | pass | 0.0s | session cookie set; onboardingState=done hasKeys=true username=e2e0aneq |
| b keys | pass | 0.0s | existing bundle unlocked with the wallet signature; keyId dba30c2f06b85bbf |
| c username | pass | 0.0s | e2e0aneq.nanitecom.eth claimed; onboarding done; txs: deploy-registry 0x9b08c6d5942c62cd0322cfb8bb7f86acb3158d27f2ebef7da48b78397ae2c030, set-parent 0xf506dc33e94670649ed887e7bdc02a083c68ed3eb85b23fbc31dd8676560f00e, register-username 0xcae839a92653f46e70a839809a32eeec84f2a7561f36cd5b18c99de076c1e0b8 |
| d agent | pass | 0.0s | alex.e2e0aneq.nanitecom.eth active (index 0), email alex.e2e0aneq@nanite.test, wallet 0xd1150dff44f40ce8a2e3bf03d128abf7b3fb8b3f, reused; txs: deploy-resolver 0x40002378f275f685844a460b7bc2d6488722cbe47caf266a762b114491e6a241, register-agent 0xf4859a350119d284d44d69aef152677815aaa13d7085aeb4685550ed2deafc7c, grant-keys 0xbd5106c95f45121cc5a36e7df843acd1e14f3924bc9acead0c566161ec189df8 |
| e ENS resolve | pass | 6.7s | addr 0xd1150DfF44F40CE8a2E3bf03D128ABF7b3fb8B3f email alex.e2e0aneq@nanite.test policy=reply-only limit=50 allow=0; agent may write only [agent-context] |
| f1 inbound conversation | pass | 7.9s | webhook 200 {"status":"stored"} |
| f2 inbound otp | pass | 7.8s | webhook 200 {"status":"stored"}; arkiv block 262721 |
| f3 user inbox + client-side decrypt | pass | 0.6s | conv 0xa238c649e07fec56441d7c433ad1168e596385df687c09cbda4fad8b174a45f4, otp 0x064a12ae5b08052ec82cfcf8ea6ff3b69217b9c7ce2334e29f85370949a7fd3e |
| f4 agent API (/v1) decrypt | pass | 1.0s | agent token decrypts conversation and latest OTP; bad token rejected |
| g arkiv raw query | pass | 0.7s | both entities: owner 0xfAD31e74F1Cb69046BBB2e4A15ce653beE6936C0, creator 0xA7B7EbE69F1bcb3ACD680d5e06cE640E0D2D247F, ciphertext only; otp expires at block 262869 |
| h outbound | pass | 54.8s | default policy reply-only; reply 200, stranger 403, allowlist set on-chain, stranger 200; 2 sent copies decrypt |
| j otp expiry | pass | 241.3s | expiresAtBlock 262869; last seen present at block 262867; first absent at block 262869 (0 block(s) past expiry); user inbox type=otp no longer lists it; /v1/otp/latest 404; conversation still there (expires block 8146716); waited 241s |
| i revoke | pass | 23.0s | token 401 (inbox and send); revoke txs 0x79abb7116b3c17bc01b0f63485222bb92acc7ebca7e6abeab690b4edba04b864; getAgentPermissions: no text record and no address writable by the agent wallet |

Sepolia transactions:

- username: deploy-registry: [`0x9b08c6d5942c62cd0322cfb8bb7f86acb3158d27f2ebef7da48b78397ae2c030`](https://sepolia.etherscan.io/tx/0x9b08c6d5942c62cd0322cfb8bb7f86acb3158d27f2ebef7da48b78397ae2c030)
- username: set-parent: [`0xf506dc33e94670649ed887e7bdc02a083c68ed3eb85b23fbc31dd8676560f00e`](https://sepolia.etherscan.io/tx/0xf506dc33e94670649ed887e7bdc02a083c68ed3eb85b23fbc31dd8676560f00e)
- username: register-username: [`0xcae839a92653f46e70a839809a32eeec84f2a7561f36cd5b18c99de076c1e0b8`](https://sepolia.etherscan.io/tx/0xcae839a92653f46e70a839809a32eeec84f2a7561f36cd5b18c99de076c1e0b8)
- agent: deploy-resolver: [`0x40002378f275f685844a460b7bc2d6488722cbe47caf266a762b114491e6a241`](https://sepolia.etherscan.io/tx/0x40002378f275f685844a460b7bc2d6488722cbe47caf266a762b114491e6a241)
- agent: register-agent: [`0xf4859a350119d284d44d69aef152677815aaa13d7085aeb4685550ed2deafc7c`](https://sepolia.etherscan.io/tx/0xf4859a350119d284d44d69aef152677815aaa13d7085aeb4685550ed2deafc7c)
- agent: grant-keys: [`0xbd5106c95f45121cc5a36e7df843acd1e14f3924bc9acead0c566161ec189df8`](https://sepolia.etherscan.io/tx/0xbd5106c95f45121cc5a36e7df843acd1e14f3924bc9acead0c566161ec189df8)
- send policy: set-send-policy: [`0xf3a3e6521add688658b43c039aa714261ac0921d2fe18b6a27a6c9a986e0daf6`](https://sepolia.etherscan.io/tx/0xf3a3e6521add688658b43c039aa714261ac0921d2fe18b6a27a6c9a986e0daf6)
- revoke: revoke-keys: [`0x79abb7116b3c17bc01b0f63485222bb92acc7ebca7e6abeab690b4edba04b864`](https://sepolia.etherscan.io/tx/0x79abb7116b3c17bc01b0f63485222bb92acc7ebca7e6abeab690b4edba04b864)

Arkiv entities (ciphertext only; owner = user wallet, creator = Arkiv operator):

- conversation (inbound): [`0xa238c649e07fec56441d7c433ad1168e596385df687c09cbda4fad8b174a45f4`](https://rabdi.explorer.arkiv.network/entity/0xa238c649e07fec56441d7c433ad1168e596385df687c09cbda4fad8b174a45f4)
- otp (inbound): [`0x064a12ae5b08052ec82cfcf8ea6ff3b69217b9c7ce2334e29f85370949a7fd3e`](https://rabdi.explorer.arkiv.network/entity/0x064a12ae5b08052ec82cfcf8ea6ff3b69217b9c7ce2334e29f85370949a7fd3e)
- sent copy (reply to inbound sender): [`0xe474755670abedd2e5f91ce10f4ce586b756dfefd1c598f72ec7fa46b4e9a280`](https://rabdi.explorer.arkiv.network/entity/0xe474755670abedd2e5f91ce10f4ce586b756dfefd1c598f72ec7fa46b4e9a280)
- sent copy (allowlisted stranger): [`0x8e710842d87c8a87912bbc08484d6103e76ed8f9fd0b72d09bf6eefb3f3a9ced`](https://rabdi.explorer.arkiv.network/entity/0x8e710842d87c8a87912bbc08484d6103e76ed8f9fd0b72d09bf6eefb3f3a9ced)

OTP expiry (T4.1):

- Entity [`0x064a12ae5b08052ec82cfcf8ea6ff3b69217b9c7ce2334e29f85370949a7fd3e`](https://rabdi.explorer.arkiv.network/entity/0x064a12ae5b08052ec82cfcf8ea6ff3b69217b9c7ce2334e29f85370949a7fd3e), written near Arkiv block 262721, `expiresAt` = block 262869.
- Last raw query that still returned it: block 262867; first raw query without it: block 262869.

## Verifiable outbound mail, live check 2026-11-05T21:59:07.165Z (signing option B)

- Agent `alex.nanitedemo.nanitecom.eth` (demo user `nanitedemo`, database `nanite_live`), API `http://nanite-api-live:4000`, fake mail provider (no real email).
- Operator balance 0.5000 -> 0.5000 ETH.
- `POST /agents/:id/signer` -> job `publish-signer`: tx [`0x32388b6d03cdea0d36fd36db5828608dc8a8f08c092a9b221820c23ffc05d611`](https://sepolia.etherscan.io/tx/0x32388b6d03cdea0d36fd36db5828608dc8a8f08c092a9b221820c23ffc05d611); signer address `0x6f8C33d4184d115325b4DaFA58F0F7EE516877fa`.
- UniversalResolverV2: `alex.nanitedemo.nanitecom.eth` text `nanite.signer` = `0x6f8C33d4184d115325b4DaFA58F0F7EE516877fa`.
- `POST /v1/emails/send` (to a recipient the reply-only policy allows) -> `signature: "signed"`; (v2 at the time; current code sends v3 with `X-Nanite-Message-Id` instead of `Message-ID`) outbound headers captured from the fake provider: `Message-ID`, `X-Nanite-Agent`, `X-Nanite-Date`, `X-Nanite-Sig-Version`, `X-Nanite-Signature`.
- `verify-mail-signature.ts` against LIVE ENS: exit 0, `{"valid":true,"agent":"alex.nanitedemo.nanitecom.eth","signer":"0x6f8C33d4184d115325b4DaFA58F0F7EE516877fa","reason":"ok"}`.
- Same mail with a tampered subject: exit 1, reason `signer_mismatch`.

## Real Resend (first real-email test, 2026-11-06)

Real inbound and outbound mail through Resend (`FAKE_RESEND_CONTENT=0`, `FAKE_RESEND_SEND=0`), live API `nanite-api-live` (database `nanite_live`) behind a Cloudflare quick tunnel, domain `nanitecom.itsvikrant.tech` (sending + receiving verified). Scripts: `live-mail-agent.ts` (part 1), `live-webhook-selftest.ts`, `live-mail-part2.ts`. No email content, tokens or keys are recorded here.

Part 1, agent `mail`:

- Agent id `d486fd54-a2a1-4566-8768-ec4843742a35`, ENS `mail.nanitedemo.nanitecom.eth`, mailbox `mail.nanitedemo@nanitecom.itsvikrant.tech`, wallet `0xd3ecdc5890802ca6dc25d4d8a44cd9b942e78b4b`. Token saved only to the gitignored `apps/api/.live-agent-token` (mode 600).
- Txs: deploy-resolver `0x4f5e0f6bb8181ebab2a8b921945a4dedcf00a5941a4d760dc8aa893ada778b5a`, register-agent `0x700add42604c861e53c5a738590ee31ce9523253af3a0d5cd110a5bac94313b8`, grant-keys `0xf9b9b93a1ebf455a76bce1a6fd2e1f96bfdd7b50459848af89b4c7224fd28569`, publish-signer `0xc9ed52aa4ea63cfa5e1979d465afed11588f3d443e2c3cf03b7e54d9aab90c77` (create job) and `0xaef0fff23e2f0211ce05767ba1a6498648afb0ef3ac04d499349bf45a448232e` (explicit rotate), set-send-policy `0x96fb4d174a15f1f3b477757720cd3074c8a0aa0415a19f63d4a19b689275467d`.
- UniversalResolverV2: addr `0xD3ecdC5890802CA6dC25d4d8A44Cd9B942e78b4B`, `email` = the mailbox above, `nanite.send` = allowlist, allow = [vikrantsingh202004@gmail.com], limit 10, `nanite.signer` = `0x4EA6629045Bf9205Cd5A9517095218769AC17Ae6`.
- Webhook self-test through the public tunnel (signed fake event, unknown recipient): HTTP 200 `{"status":"dropped"}`, one log line, no retry loop.

Part 2, real mail from vikrantsingh202004@gmail.com:

- Inbound stored as type `otp` (webhook event `msg_3LiHN6n2WBw1bbRUsLbh22a6EGN`), entity [`0x0e9d5017b263fc0e51f74b271ec9f0a9327b674a5dfb1b10674f5cce9178699f`](https://rabdi.explorer.arkiv.network/entity/0x0e9d5017b263fc0e51f74b271ec9f0a9327b674a5dfb1b10674f5cce9178699f).
- User inbox, decrypted client-side: subject present (46 chars), body present (230 chars), `meta.from` equals the sender, `meta.messageId` present, OTP detected (yes), 0 links.
- Raw `arkiv_query`: 1 entity, owner = user wallet, creator = Arkiv operator, neither subject nor sender address found in the raw response.
- Agent API with the agent token: `/v1/inbox` 200 and lists the entity; `/v1/emails/<key>` 200, subject and body match the user-side decryption, OTP present, `content_trust: untrusted`.
- Reply (`POST /v1/emails/send`, `inReplyTo` = the entity key, one send): HTTP 200, `signature: "signed"`, provider id `01a1ae8f-5256-745d-88c9-3ab4ce012c0e`, sent copy [`0xc90059b537ee27a3c1ab7d19d514ba5c82957e84ab2b4428de1871e2fbaa2618`](https://rabdi.explorer.arkiv.network/entity/0xc90059b537ee27a3c1ab7d19d514ba5c82957e84ab2b4428de1871e2fbaa2618). The response has no `threading` field; the sent copy carries `meta.inReplyTo`.
- Sent copy appears in the user inbox as type `sent` and decrypts (subject, body, `to`, `inReplyTo` all as expected).
- Resend `GET /emails/<id>`: 200, `last_event: delivered`; fields returned: object, id, to, from, created_at, subject, bcc, cc, reply_to, last_event, scheduled_at, message_id, html, text. There is NO `headers` field, so the `X-Nanite-*` values cannot be read back from Resend.
- Finding (Gmail "Show original" of that reply): Resend/Amazon SES REPLACED our `Message-ID` (`<141635a2-1736-4ff0-954b-98cd05650e97@nanitecom.itsvikrant.tech>` became `<010601a1ae8f54f4-...-000000@ap-northeast-1.amazonses.com>`, also `message_id` in `GET /emails/{id}`). `In-Reply-To`, `References` (Gmail threaded it) and all `X-Nanite-*` headers were kept. The mail was signed with v2, which covers `Message-ID`, so the delivered mail could not verify. Proof that the signature itself was genuine (R1): the sent copy was decrypted in memory and verified against live ENS: with our original Message-ID `valid: true` (signer `0x4EA6...7Ae6`), with the delivered SES Message-ID `signer_mismatch`. Fixed by signature v3 (signs `X-Nanite-Message-Id`, no `Message-ID` set; see README "Verifiable outbound mail" and docs/resend-integration.md G12 and 5d); the next real send needs the API restarted with this code.
- Signature verification of the delivered mail is manual: in Gmail open the reply, menu (three dots) -> "Show original", copy the header block, and put the values of `X-Nanite-Message-Id` (v3; `Message-ID` for a legacy v2 mail), `X-Nanite-Agent`, `X-Nanite-Date`, `X-Nanite-Sig-Version` and `X-Nanite-Signature` into the `headers` object of a JSON file together with `from` (the agent mailbox address, bare), `to`, `subject` and `body` exactly as sent, then run `docker compose run --rm tools npx tsx apps/api/scripts/verify-mail-signature.ts mail.json` (format in the script header). Expected: `valid: true`, signer `0x4EA6...7Ae6`.
