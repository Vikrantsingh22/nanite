# Nanite logbook

Short, dated record of what was done, in order. Newest at the bottom. Transaction hashes and addresses only, never keys.

## 2026-11-05: T0.1 + T0.4 (Sepolia ENSv2 naming)

- Saved project docs to `claude/` (summary, status and decisions, task plan). Rules added: Docker for everything, no commits until Vikrant says so, no Claude co-author, main session orchestrates and Sonnet subagents write code.
- Started Docker Desktop.
- Step 1 done: Docker skeleton (`tools` and `signer` services), `CLAUDE.md`, `.gitignore`, `.env.example`, `config/sepolia.json`, `contracts/abi/`, `docs/wallets.md`, `arkiv/*.md`.
- Step 2 done: ABIs from `ensdomains/contracts-v2` at commit `07e55a05`. All 8 addresses match the deployment files and have code on Sepolia. Differences from our docs are in `docs/abi-check.md`: `setParent(address,string)`, `setText` and `setAddress` take a DNS-encoded name, and `grantSetterRoles` takes the setter calldata.
- Step 3 skipped (Vikrant confirmed on Etherscan). Also confirmed on chain: the owner holds `ROLE_SET_SUBREGISTRY` on `nanitecom`.
- Owner signing page built (`docker compose up -d signer`, http://localhost:5173). Owner transactions simulated from the owner: `deploy-user-registry` OK, `set-subregistry` OK.
- UserRegistry salt `keccak256("nanitecom.eth/user-registry/v1")`; predicted proxy `0xD2BE04253E815972D6a1D995670eBAc7a6C8C786` (checked against the factory's `predictProxyAddress`).
- Step 6 done early (needed for funding): operator `0x38Cb…3dab`, test user `0xfAD3…36C0`, agent 0 `0xC057…287b` and agent 1 `0xd817…Fab8`, derived from the test seed at `m/44'/60'/0'/0/<i>`. Keys are only in local `.env`.
- Confirmed agent wallets are derived from one seed by index, not created as standalone keys.
- Step 4 done: owner signed `deployProxy`, tx `0x42b6b01df0031215ee45d9e2078da2267dc65983f8e8c699ed2111ff9457e602` (block 12069753, success). The UserRegistry for `nanitecom.eth` is at `0xD2BE04253E815972D6a1D995670eBAc7a6C8C786`, as predicted; the owner holds root roles.
- Funding received: operator 0.5 ETH, agent 0 0.05 ETH, test user 0.05 ETH.
- Built and simulated (from the owner, all OK): `set-subregistry`, `set-parent`, `grant-operator` (roles `0x10001` = REGISTRAR | RENEW, no admin roles, to operator `0x38Cb…3dab`).
- Step 5 done: `setSubregistry` tx `0x06f7c0994bbf3e95be6d7122f5e28293540bf4eabb9daa379769d1ff43ac1419` (block 12069792), `setParent` tx `0xe03f861f0ec2feef022436c60b6128127c3742c3a3f4d457b5bf522a2024236e` (block 12069796). Verified: `ETHRegistry.getSubregistry("nanitecom")` returns `0xD2BE…C786`; `getParent()` returns (ETHRegistry, "nanitecom").
- Step 7 done: `grantRootRoles` tx `0x80e23820bf2b6d59612ec943f262521b3f0b20d16a2949cda74bf2a7455ff5d2` (block 12069801). Verified: the operator has REGISTRAR | RENEW and no admin roles or SET_PARENT.
- Step 8 done (simulation only, `scripts/ens/simulate-register.ts`, reproduced by the orchestrator): the operator can `register()` directly. A child expiry later than the parent's is allowed (no clamp in the contract); a past or `now` expiry reverts `CannotSetPastExpiry`. Registering grants the owner any role bits, admin roles included, without checking the caller's roles. A non-operator reverts `EACUnauthorizedAccountRoles`. Names resolve through UniversalResolverV2 automatically; when the parent expires, all subnames stop resolving.
- Vikrant approved: deploy the resolver before register (steps 10a then 9), and role set D3 for the test user on `t04test`. Steps 10a, 9, 10b and 11 started from the operator.
- Step 10a done: the operator deployed the PermissionedResolver proxy `0xd8Bab6066f02Edc516538d91c44Efae7e4145744` (as predicted), tx `0x16643eee2e53745bd1b9261b8eecea71f77bcc4a3c81d5be9ccb37a4469614bc` (block 12070087). Initial records: addr = agent 0, `email`, `nanite.pubkey` (placeholder), `agent-context`. The operator and test user hold SET_TEXT | SET_ADDRESS and their admin roles; nobody holds UPGRADE.
- Step 9 done: the operator registered `t04test.nanitecom.eth` for the test user with role set D3 and that resolver, tx `0xfb4e34adf38b20704bbc9d6d7c5a7c82bd67bc7b6f44513b4abe893588d10d86` (block 12070089). Expires 1796481084 (30 days, below the parent's).
- Step 10b done: `grantSetterRoles` gives agent 0 the `agent-context` text key only, tx `0xc257a7a154792b8f31b14f03055ef73224dec1153a58b60b5159d914496bbf22` (block 12070092).
- Step 11 done: resolves through UniversalResolverV2 (addr = agent 0, email, pubkey, agent-context). Agent 0's real write succeeded: tx `0x0e809bafee700c2489c302dbd1967134ceb6ae926448346945286980ee9e9a31` (block 12070093). Simulated and reverted with `EACUnauthorizedAccountRoles`: agent 0 setText(`email`), agent 0 setAddress(60), agent 1 setText(`agent-context`). Re-verified by the orchestrator.
- Side effect: the orchestrator's re-run of `verify.ts` sent one extra agent-0 `agent-context` write, tx `0x363eb160eb5578134b0dfa32ffb96cd2e8598d79848f8dd06b3828ecd2f882d2` (block 12070099). Harmless; `verify.ts` is being made read-only by default (`--write` to send).
- Fixes: `verify.ts` is now read-only by default (`--write` sends); the typecheck passes (`tsc` exit 0). T0.1 and T0.4 are marked Done in the task plan; handoff notes are written and the status file is updated. Signing page stopped.

## 2026-11-05: T0.3 (Arkiv spike)

- The orchestrator read the Arkiv docs and the AI tools page. Key facts: Rabdi testnet (chain 7794095, tGLM gas); schema SDK; 128 KiB `bytes` per create; maximum lifetime about 182.5 days; the creator is the owner (no delegation; `changeOwnership` exists); access keys are only RPC keys. The Arkiv Claude Code plugin offers a Mumbai MCP profile (install pending Vikrant's decision).
- Plan: W0 bootstrap, then W1 (size and cost), W2 (expiry), W3 (writer model) and W4 (schema and queries) in parallel, each with its own derived wallet. W0 started.
- W0 done: SDK `@arkiv-network/sdk@1.0.1` pinned (only 3 days old, a deliberate exception: the newest version older than 2 weeks, 0.8.1, predates the schema API). Added `scripts/arkiv/{lib,schema,wallets,distribute,connectivity}.ts`, `docs/arkiv-spike/sdk-notes.md`, and the Arkiv wallets (funder index 0 `0x05DE…918C`) in `docs/wallets.md`. From the SDK source: `executeBatch` can create and transfer ownership in one tx; there is no owner param on create; flags are readonly 0x01 and permissionlessExtension 0x02.
- Blocker: the Rabdi RPC and explorer hang after the TLS handshake from this machine (host and Docker, IPv4 and IPv6); docs, hub and status respond, and the status page says all is operational.
- RPC reachable after Vikrant switched networks (chain 7794095, block 253361; test query OK). W1 (size and cost), W2 (expiry), W3 (writer model) and W4 (queries) launched in parallel. Each prepares its scripts now and runs on chain once its wallet is funded.
- Vikrant funded the Arkiv funder (index 0) with about 10 tGLM via his own MetaMask account (faucet, then transfer). The orchestrator ran `distribute.ts 1.5`: 1.5 tGLM to each of indexes 1–6 (tx 0xfb79…45b2, 0x3e1b…4f04, 0x86b8…4111, 0x79c3…f00, 0xb335…ed45, 0xddd8…b14c). Funder keeps about 1 tGLM. W2 started on chain right away.
- W2 done (re-verified: stranger extend tx `0xa3283c0b…ceec28` succeeded from index 7 `0xE1c9…c99B`; the expired OTP `0x554e…7773` returns null). OTP expiry is exact to the block (gone about 4 s after `$expiresAt`). Extend counts from now; maximum lifetime 7,884,000 blocks enforced by the SDK. `permissionlessExtension` lets anyone extend (it must be passed as `{permissionlessExtension: true}`; a numeric 0x02 is silently ignored). Gas is 1 gwei; a create is about 0.00018 tGLM, a max-lifetime create 0.00056, and a year of retention about 0.0014 tGLM per email. Expiry fires no event, and the ciphertext stays in tx history.
- W3 done (re-verified: batch tx `0xb4a30310…e037` from the operator; entities show owner = user index 4, creator = operator index 3). Create + changeOwnership in one `executeBatch` works. After the transfer the operator can't patch, delete, extend or transfer; with `permissionlessExtension` the operator can still extend. A stale key prediction reverts the whole batch atomically (fails safe), so operator sends must be serialized. Recommendation: the operator creates and transfers to the user in one batch.
- W1 done (re-verified: largest entity tx `0x6c55c5e243…` used 130,916 bytes of tx input, 5.18M gas). Real size cap is about 128.2K ciphertext bytes (tx size limit), about 2.7 KB under the SDK check, and failing with no size hint. A typical 24 KiB encrypted email costs 1.04M gas (about 0.001 tGLM). Gas is about 164k + 40 per byte. Batching saves about 1.5% and is capped by the same tx size. Longer expiry costs more (+47% for 30 days against 1 hour).
- W4 done (re-verified: `readme-query.sh` returns the seeded inbox for `alex`, pinned to `$creator`, count 8; `tsc` exit 0). All seven query types are correct. The attacker's fake OTP entities appear in naive queries and in "latest OTP", and pinning `$creator` excludes them. Readable 0.35–1.3 s after the receipt, queryable in 0.6–2.2 s.
- Merge: all worker friction is in `arkiv/friction.md`. The status file has the confirmed Arkiv facts and open items; the task plan has T0.3 marked Done plus handoff notes. The writer model is waiting for Vikrant to confirm.
- Vikrant decided: do not install the Arkiv AI plugin.
- Vikrant added a use case: agents send email to anyone, permitted by ENS. Policy records `nanite.send` / `nanite.send-allow` / `nanite.send-limit` live on each agent's resolver and can be set only by the user or operator. Added to the summary (new section, demo step 6), the status file (decision), the T2.2 deliverable, and a new task T3.5 (2.5h) in the task plan.
- Vikrant confirmed the Arkiv writer model (operator creates and transfers to the user in one batch; permissionlessExtension on conversation mail, not OTPs) and the client-side decryption approach (one wallet signature per session, no gas). Recorded in the status file. T0.3 is closed.
- Git started: repo initialized on `main`; Phase 1 (6 commits, foundations) done at 22:20 IST. Phases 2 (ENS, about 23:20) and 3 (Arkiv and docs, about 23:40) are planned in `claude/commit-plan.md` (local only, excluded from git).

## 2026-11-05: T0.2 (repo scaffold, stack, hosting)

- Vikrant's decisions: MIT license; the "Secure terminal" visual direction; Vercel for frontend and backend with Neon Postgres (Cloudflare free rejected over its 10 ms CPU limit). Use taste-skill, frontend-design and the shadcn skill for design, Playwright in Docker for visual validation, and run nothing on the host.
- A1 (foundation) started.
- Cleanup: stopped two stray containers left running from W2's expiry script.
- A1 done (re-verified in Docker: lint and typecheck pass; `/api/health` returns `{"ok":true,"db":"up"}`; deps pinned; `.env` and `.design-refs/` ignored). npm workspaces; `apps/web` on Next 16.4.2, React 19.3, Tailwind 4.3.3, shadcn 4.22.1 (radix-nova); Postgres 17.6 and web in compose; CI; MIT LICENSE; README; design references downloaded to `.design-refs/` (reference text only).
- A2 (design system and `/styleguide`) and A3 (Playwright in Docker, own `e2e/` package) started in parallel.
- A3 done (re-run by the orchestrator: 7 passed, 9 skipped while `/styleguide` doesn't exist yet). `@playwright/test` 1.64.1, the `mcr.microsoft.com/playwright:v1.64.1-noble` image, axe 4.14.0, and Microsoft's agent CLI `@playwright/cli` 0.1.22 (usable). Compose service `e2e` under profile `e2e`. A3 reported one rule breach: a `python3` text edit of `docker-compose.yml` on the host. Follow-ups: the CLI's Chromium path is hardcoded for arm64 (breaks on x86 CI); `e2e/` tests aren't typechecked.
- A2 done: the "Secure terminal" design system (Host Grotesk + Martian Mono, OKLCH tokens in dark and light, next-themes), 35 shadcn components, 10 Nanite pattern components, `/styleguide` (9 sections) and a new home page. A2 also broke the no-host rule (python3 text edits).
- Orchestrator review (full suite: 14 passed, 2 failed):
  - the axe a11y failures on `/styleguide` (contrast, toggle label, scroll-area focus);
  - **the page loads scrolled to Components** and hash links don't land;
  - an empty 6th principles cell;
  - cramped color-card labels;
  - a left-heavy home page;
  - a placeholder explorer URL;
  - the dev indicator showing in screenshots.

  Fixes sent to A2; portability, typecheck, a scroll test and viewport shots sent to A3. Both now use the editor tools only.
- A3 follow-ups done (`e2e` typecheck re-verified in Docker): the arch-independent CLI wrapper `e2e/bin/pw-cli.sh`, the e2e typecheck in CI, scroll and hash smoke tests, and viewport screenshots. Its suite run had 14 passed and 4 failed, all on A2's in-progress `/styleguide` (expected). A3 noted one small slip: a `printf` append to `.gitignore`.
- A2 review fixes done (all 8). Re-verified by the orchestrator in Docker: lint, typecheck and build pass. The suite's first run had 17 passed and 1 axe failure while `next build` ran next to the dev server; then two clean runs of 18/18. Screenshots reviewed at 1440 and 390: `/styleguide` opens at the top, `#patterns` lands, the home page has the product composition, and there's no dev indicator.
- Hosting revised (2026-11-06, Vikrant): frontend on Vercel; backend API (`apps/api`, Hono) and Postgres in Docker on an AWS Lightsail $12 instance from the $100 credits, with Caddy for HTTPS and images from GHCR. Neon dropped. Added task T0.5 (API scaffold and production compose, 1h); T4.3 rewritten for Lightsail.
- Deployment deferred (Vikrant: finish the build first). T0.5 is now only the `apps/api` scaffold for local dev; the production Dockerfile, prod compose, Caddy, GHCR and the Vercel rewrite moved into T4.3.

## 2026-11-06: Build, Phase 1

- Started in parallel: B1 = T1.2 `packages/crypto` (libsodium sumo: XChaCha20-Poly1305 envelope, sealed boxes, HKDF/Argon2id wrapping, seed and agent derivation, sender blind index) and B2 = T1.1 `packages/db` (Drizzle + SQL migrations, all tables, seed, constraint tests). B3 = T0.5 `apps/api` (Hono) follows B2 because it imports `packages/db`.
- T1.1 done (B2; re-verified: 11/11 tests, seed idempotent, typecheck OK). `@nanite/db`: Drizzle 0.45.4, migration `0000_real_the_hunter.sql`, 12 tables, the "never stored" rules as comments plus DB checks (lowercase wallets, custody, label regex). `send_log` stores an HMAC of the recipient, never the address.
- T1.2 done (B1; re-verified: 19/19 tests, including jsdom with no Node APIs; no `node:` imports). `@nanite/crypto`: libsodium sumo 0.8.4. Envelope v1 = XChaCha20-Poly1305 with keyIds bound as associated data; 80 B sealed key per reader. A 24 KiB email with 2 readers is 24,805 B. Argon2id recovery takes about 0.1 s and passphrase about 0.3 s. Recovery code is 125-bit Crockford base32.
- Install issue fixed: vitest 5 broke plain `npm install`. The orchestrator decided to pin vitest 4.1.12 everywhere with no `legacy-peer-deps`; plain install verified OK. Root lint and typecheck pass. B1 ran a few read-only `cat`/`ls` on the host early on.
- B3 (T0.5 `apps/api`, Hono) started.
- T0.5 done (B3; re-verified: `/health` returns `{"ok":true,"db":"up"}` from the `api` service on 127.0.0.1:4000, foreign origins get no CORS header, 12/12 API tests, e2e 18/18). Hono 4.13.13; migrations run at API start; logs never include bodies. The Next health route was removed and the web app reads `NEXT_PUBLIC_API_BASE_URL`. The orchestrator fixed the stale "Vercel for everything" text in CLAUDE.md.

## 2026-11-06: Build, Phase 2

- Three agents launched in parallel:
  - **C1, `packages/arkiv` (T1.4 + write primitives):** schema `nanite.email.v1` (adds `type=sent` and `keyIds`), reads pinned to `$creator`, create-and-transfer in one batch, a single-flight queue, a size guard, extend, and filling `arkiv/schema.md`.
  - **C2, `packages/ens` (T2.1):** user and agent names with allowlisted roles, a resolver per agent with send-policy records (default `reply-only`), resumable steps, a live check on `t21test.nanitecom.eth`.
  - **C3, the inbound half of T1.3 in `apps/api`:** Resend provider interface, Svix signature check, dedupe, drop unknown recipients before fetching, OTP classification, encryption to both readers, handoff to an `ArkivWriterPort` interface.
- The wiring step (plugging C1's writer into C3) follows.
- C3 done (re-verified: 29/29 API tests, typecheck OK, pipeline logs contain only event, outcome, id, type and count). `POST /webhooks/resend`:
  - **Security:** Svix check (5-minute tolerance, published test vector); answers 503 when unconfigured.
  - **Dedupe:** on the Svix id, with re-claim of failed or stuck events.
  - **Unknown recipients:** dropped before any content fetch.
  - **Classification:** OTP vs conversation; `threadId` is an HMAC of the thread root.
  - **Encryption and handoff:** encrypted to the user and the agent, then passed to `ArkivWriterPort` (in memory for now).
  - Uses plain `fetch` to Resend, not the SDK.
- Decisions for the wiring step (orchestrator):
  - (a) Add a proper `meta` field (OTP, links) to `@nanite/crypto` instead of carrying JSON in the `rawEml` slot.
  - (b) Map the port to C1's schema v1 (`keyIds`, `type=sent`).
  - (c) Move writes onto the `arkiv_writes` outbox so the webhook answers fast and per-recipient retries don't rewrite.
- C1 done (re-verified: 28/28 tests, plain install OK). Live entity `0x1300bb0c…7284` (tx `0x527fd094…42b9`): on the public RPC, owner = index 4 (user) and creator = index 3 (operator). `@nanite/arkiv` has a browser-safe reader (creator pin re-checked on every row, `UntrustedEntityError`) and a server writer (one `executeBatch` create + transfer, re-predict and retry, FIFO queue, 125 KiB guard). `arkiv/schema.md` is filled in with a runnable curl.
- Decision (c) revised by the orchestrator: no async outbox. Writes stay synchronous in the webhook, with per-recipient idempotency rows in `arkiv_writes` (unique on event + mailbox), so no ciphertext or plaintext is ever stored in Postgres. D1 (the T1.3 wiring) started.
- C2 done (re-verified: 23/23 tests; `alex.t21test.nanitecom.eth` resolves through UniversalResolverV2 to agent 0 with email `alex.t21test@nanite.test`, `nanite.send = allowlist`, `send-allow = friend@example.com`, `limit = 50`). `@nanite/ens` creates a user name (own registry), an agent name (own resolver with 8 records, setter role on `agent-context` only), the send policy (fresh reads, fails closed), revoke and resolve; resumable, simulate first, single-flight.
  - Live Sepolia transactions: user registry `0x8f6C…8C71`, agent resolver `0xCAf9…588b`; about 5.0M gas for a user plus their first agent.
  - Agent 0: allowed to write `agent-context`; rejected on `nanite.send` and `email`; rejected on everything after revoke.
- C2 went beyond the spec on roles: the operator gets SET_PARENT (needed) and UNREGISTER (lets the dashboard remove agent names without a user signature) on each user's registry. Waiting for Vikrant's OK. C2 ran one host `mkdir`.
- Root lint currently fails in `packages/db/test` (D1's in-progress migration test). Recheck after D1.
- D1 done, T1.3 wired. Re-verified by the orchestrator: crypto 21, db 13, arkiv 28, api 33, e2e 18/18; lint and typecheck clean. Live entity `0xa630…33a2` has owner = user (index 4) and creator = operator (index 3).
  - **Crypto:** `meta` (OTP, links) inside the envelope, still version 1 (a flag bit).
  - **Migration `0001`:** per-recipient `arkiv_writes` idempotency.
  - **API:** a real shared writer; `/internal/dev/inbox` (dev only, metadata only); a dev key script.
  - **Live and end-to-end:** both readers decrypt; the fake webhook returns 200 stored; the entities are listed from Arkiv.
  - **Known gap:** a crash between the chain write and `confirmed` can create a duplicate entity on retry (documented).
  - D1 ran one read-only host `ls`.

## 2026-11-06: Build, Phase 3

- F1 (T3.1: SIWE sign-in, browser key setup with double-sign check, passphrase fallback, recovery code, username claim through `@nanite/ens`, unlock into memory only) and F2 (T3.4: custody=nanite agent keys under the master key, hash-only tokens, `/v1/inbox` `/v1/emails/:key` `/v1/otp/latest` `/v1/emails/wait`, rate limit, audit without content, MCP server in `packages/mcp`) started in parallel. Neither may change the schema without asking.
- E1, F1 and F2 all stopped mid-task when the Claude 5-hour usage limit was hit; it reset at 01:20 IST. All three resumed at 01:21 from their saved state, told to re-check their files and the on-chain state before continuing.
- F2 done, T3.4 (re-verified: agent-api 13/13, mcp 3/3).
  - **Tokens:** `nan_` tokens, stored as SHA-256 only, with an identical 401 for every failure.
  - **Endpoints:** `/v1/inbox`, `/v1/emails/:key` (content wrapped as untrusted), `/v1/otp/latest`, `/v1/emails/wait` (long-poll, 204 on timeout), `?raw=1` for self-custody.
  - **Limits and audit:** 60 requests/min per token; audit rows without content.
  - **Custody keys:** wrapped with an HKDF of `NANITE_MASTER_KEY`, bound to the agent id.
  - **MCP:** `@nanite/mcp` with 4 tools.
  - **Live:** entity `0xd694…658f` decrypted through the API.
  - **Open failures in F1's in-progress files:** one `app.test` env expectation, and e2e `/styleguide` visual. Recheck after F1.
- G1 (T3.5 outbound send permitted by ENS) started.
- E1 done, T2.2 (re-verified: 27/27 ens unit tests; `alex.t22test.nanitecom.eth` resolves to agent 0 with `nanite.send = reply-only`; `bob.t22test` no longer resolves after unregister; no leftover containers).
  - Users now hold RENEW (`0x1110…1110000`) and `getAgentPermissions` was added.
  - Live a–g passed: the agent's own write worked (tx `0xbb31…5c14`); `email`, `nanite.send` and `addr` were refused; the user's renew simulation was OK; revoke blocks; unregister works.
  - Live-test overlap: an orphaned container sent a few extra txs (logged in `live-check.md`).
  - The final `LabelExpired` handling in `revokeAgent` is unit-tested only.
  - Added `packages/ens/live-*.log` to `.gitignore`.
- Vikrant confirmed: keep UNREGISTER (and SET_PARENT) for the operator on user registries; users also get RENEW on their own name. Recorded in the status file. E1 (T2.2: RENEW change, live permission and revoke test on the fresh name `t22test`, `getAgentPermissions` helper) started in parallel with D1.
- T0.2 closed: task plan status and handoff written, duplicate `.gitignore` line removed, and commit Phase 4 (14 commits) added to the local `claude/commit-plan.md`. Phases 2 and 3 haven't been run yet.

## 2026-11-06: G1 (T3.5) outbound send done
- `POST /v1/emails/send`: reads the ENS policy fresh on every request; unknown or failed reads refuse the send. Modes `off`/`reply-only`/`allowlist`/`any`, daily cap from `send_log`, encrypted sent copy on Arkiv (`type=sent`, owner = user).
- Verified in Docker: outbound 13/13, arkiv 28/28. Live (fake provider, no real email): `alex.t21test` allowlist sends to `friend@example.com` (200) and refuses `stranger@example.com` (403).
- Open: agent-wallet signing (key custody), `In-Reply-To`/`References` threading, allowlist snapshot format, non-atomic daily-cap check.
- Process: G1 made some file edits through the host shell (python3/echo/heredoc); no npm or node on the host.

## 2026-11-06: F1 (T3.1) sign-in, keys, onboarding done
- SIWE (EOA, nonce single-use, 7-day HttpOnly session cookie, Origin check), `/onboarding/*` keys + username claim (in-memory ENS job runner), web `/onboarding` wizard and `/unlock`. Keys live only in React state.
- Verified in Docker: npm install, lint, typecheck clean; api 77 (+3 skipped), db 13, crypto 21, arkiv 28, ens 27, mcp 3; e2e 21/21. The earlier `app.test` env failure is fixed.
- Not exercised: a real wallet and a real Sepolia username claim (mocked in tests). Nit: the recovery-code grid has an empty sixth cell.
- Started H1 (T4.2 docs), I1 (T3.2 add-agent + send-policy controls), I2 (T3.3 dashboard and inbox).

## 2026-11-06: H1 (T4.2) first pass
- Rewrote README (mermaid inbound/outbound, writer model, ENS roles, Docker quickstart, agent API + send errors), added `docs/ens.md`, `arkiv/query.curl.sh`; fixed the quoted-literal comment in `docs/arkiv-spike/query.curl.sh`.
- Verified judge query on Rabdi at block 261752: 4 entities by operator (3 long-lived, expiring around block 8.14M). ENS reads for alex.t21test / alex.t22test match.
- Follow-up sent to H1: fill the reach/why/how Arkiv pages, update the v0 spike query, the packages README, token issuance note, and make the query script portable.

## 2026-11-06: commit Phase 2 (ENS module)
- 7 commits, 9dc3203..68fa890: owner tx builder, signer page + signed tx records, register simulation, shared ENS lib + deployment record, agent resolver/name/grant scripts, verify script, ABI check doc. Author Vikrant Singh, no co-author lines. Phase 3 (Arkiv) is next, about 20 minutes later.

## 2026-11-06: H1 (T4.2) second pass
- Filled `arkiv/reach.md`, `why-arkiv.md`, `how-you-use-arkiv.md` with spike numbers and 3 real entity explorer links; `readme-query.sh` moved to v1; `packages/README.md`; `arkiv/query.curl.sh` is POSIX sh, run via a throwaway alpine container (same 4 entities).
- Spot-checked: reader `UntrustedEntityError` on creator mismatch and the writer refusing permissionlessExtension on OTPs both exist in code.
- Left: README AI-use note; confirm the web sandbox/CSP claims once T3.3 lands.

## 2026-11-06: I2 (T3.3) dashboard and inbox done
- API `GET /mail/:agentId/inbox` and `/mail/:agentId/emails/:key` (session, owner + creator pinned, no-store; server never decrypts). Web `/dashboard`, `/agents/[id]` (All mail + One-time codes tabs, browser decryption, explorer links).
- HTML email: `<iframe sandbox="">` + CSP meta (`default-src 'none'; img-src data:`), DOMParser pre-strip, remote images counted and blocked, links shown as text. Verified: mail 10/10, inbox e2e 5/5 (no request to evil-* hosts), screenshots reviewed.
- Open: the sender address isn't stored (only the HMAC), so the inbox shows "sender 77ab77ab"; `/unlock` has no `?next=`; no live webhook-to-inbox check yet. Root lint currently fails in I1's in-progress files.

## 2026-11-06: I1 (T3.2) add-agent + send-policy controls done
- API `/agents` (create 202 with token shown once, hash stored; status; retry; send-policy GET/PUT via operator SET_TEXT; token rotate; revoke cuts DB access immediately, then a revokeAgent job with unregister off). Shared `withOperatorLock` serialises operator txs across claim and agent jobs.
- Agent encryption key custody: nanite by default (server-generated, sealed under NANITE_MASTER_KEY); optional self-custody via `encryptionPublicKey`. The seed-derived encryption key isn't used yet.
- Web `/agents/new` (wallet derived from the seed in the browser, only name/index/walletAddress posted) and `/agents/[id]/settings`. Recovery-code grid fixed.
- Verified: install, lint, typecheck clean; api 102 (+3 skipped), db 13, crypto 21, arkiv 28, ens 27, mcp 3; e2e 29/29; screenshots reviewed.
- Process slip: one `sed` on the host by I1.

- J1 started: meta.from/messageId inside the encrypted payload, `/unlock?next=`, first live E2E (SIWE, claim, add agent, inbound, outbound policy, revoke) on Sepolia + Arkiv with a fake provider, and T4.1 OTP expiry + seed script.

## 2026-11-06: commits
- Phase 3 on hold (Vikrant). From Phase 4 only `9912de5 chore: add MIT license` and `337d890 chore: ignore build output...`; the rest of Phase 4 is stale and will be replanned in dependency order after J1.

## 2026-11-06: J1 first live end-to-end run + T4.1
- Fixes: `meta.from`/`messageId`/`references` inside the encrypted payload; `/unlock?next=` with a safe-path check; onboarding crypto helpers moved into `packages/crypto/src/onboarding.ts`.
- Live run (Sepolia + Arkiv, fake provider): `e2e0aneq.nanitecom.eth`, agent `alex.e2e0aneq.nanitecom.eth`, wallet 0xd1150dff44f40ce8a2e3bf03d128abf7b3fb8b3f. Txs: deploy-registry 0x9b08c6d5…c030, set-parent 0xf506dc33…0f00e, register-username 0xcae839a9…e0b8, deploy-resolver 0x40002378…a241, register-agent 0xf4859a35…fc7c, grant-keys 0xbd5106c9…9df8, set-send-policy 0xf3a3e652…daf6, revoke-keys 0x79abb711…b864. Entities: conversation 0xa238c649…45f4, otp 0x064a12ae…d3e, sent 0xe4747556…a280 and 0x8e710842…9ced. Run 1 failed at the raw query (script bug), run 2 passed all steps.
- T4.1: the OTP (expiry block 262869) was present at 262867 and gone at 262869; `/v1/otp/latest` 404; the conversation stays. `seed-demo.ts` (nanitedemo, agents alex + scout, 5 emails) is idempotent.
- The live run used a separate DB `nanite_live`, because the test wallet is the dev seed's placeholder user. Added `NANITE_MASTER_KEY` and `FAKE_RESEND_SEND=1` to local `.env`.
- Verified in Docker: lint, typecheck; api 104 (+3), db 13, crypto 24, arkiv 28, ens 27, mcp 3; e2e 30 (1 flaky: agents settings test passed on retry).
- Open: inbound HTML isn't stored (text only), so the iframe isn't reachable from real mail; the demo DB choice.

- Vikrant: inbound stays text only for now; keep `nanite_live` separate for the demo, with a clean DB for deploy (recorded in the status file).

- Vikrant: threading yes; keep the hash in the send log; global quota 90/day (sent + received). Signing A/B/C still open (explained B). K1 started: threading, atomic per-agent limit + global quota, flaky agent-settings e2e.

## 2026-11-06: K1 threading + atomic limits + quota
- Replies set `In-Reply-To`/`References` from the encrypted source meta (sanitized, max 20 ids); `threading:"unavailable"` when not possible.
- `reserveSend`: one transaction with global then per-agent `pg_advisory_xact_lock`; `DAILY_MAIL_QUOTA` (default 90) = allowed sends + webhook_events today; over the cap 429 `quota_exhausted`, inbound still stored. New `GET /usage` + dashboard "mail today N / 90". No schema change.
- Flake not reproduced in about 100 runs; likely a theme/dialog animation vs axe timing issue, fixed with `settleAnimations()`.
- Verified in Docker: lint, typecheck; api 119 (+3), db 13, crypto 24; e2e 30/30 with retries=0.
- Signing (A/B/C) still waiting on Vikrant.
- Vikrant chose signing option B. L1 started (signer key + `nanite.signer`, v2 signature headers, verify library + CLI, settings section, live check on nanitedemo/alex).
- L1 done: migration 0002 (`agents.signer_address`, `agents.signer_key_sealed`), publish-signer job step, `GET/POST /agents/:id/signer`, v2 signed outbound, `verifyNaniteSignature` + CLI, settings "Mail signing" card. Live: alex signer 0x6f8C...77fa published in tx 0x32388b6d...d611, CLI verdict valid. Verified in Docker: lint, typecheck, tests (ens 37, api 132, db 13, crypto 24, arkiv 28, mcp 3), e2e 31/31 with retries=0.

## 2026-11-06: L1 outbound signing (option B)
- Migration 0002: `agents.signer_address`, `agents.signer_key_sealed` (nullable). Signer key sealed under NANITE_MASTER_KEY with its own label; the create job publishes `nanite.signer`; `GET/POST /agents/:id/signer` (rotation keeps the old key until ENS has the new one). v2 canonical string over ens/from/to/sha256(subject)/sha256(body)/date/message-id, EIP-191. `verifyNaniteSignature` in @nanite/ens + CLI `verify-mail-signature.ts`. Settings "Mail signing" section.
- Live: `nanite.signer` for alex.nanitedemo.nanitecom.eth = 0x6f8C33d4184d115325b4DaFA58F0F7EE516877fa, tx 0x32388b6d03cdea0d36fd36db5828608dc8a8f08c092a9b221820c23ffc05d611. A signed send verified valid against live ENS; tampered subject gives signer_mismatch.
- Verified in Docker: lint, typecheck; api 132 (+3), ens 37 (+7), db 13, crypto 24, arkiv 28, mcp 3; e2e 31/31 retries=0. Dev `/internal/dev/outbox` needs non-production + DEV_ROUTES + FAKE_RESEND_SEND.
- Process slip: L1 appended a test block via a host heredoc (passes lint/typecheck).

- Commit plan replanned: Phases 4 to 7 (12 + 11 + 9 + 4 = 36 commits) in dependency order; dry-run coverage complete, no real keys in any file. Phase 3 unchanged and on hold.

## 2026-11-06: commit Phase 4 (workspace + packages)
- 12 commits bd1de35..0c20ae7: workspace manifests, crypto (2), db (3), arkiv (3), ens (2), mcp. Author Vikrant Singh, no co-author lines. Phase 5 (API, 11 commits) is due about 20 minutes later.

## 2026-11-06: Resend integration review
- M1 read the Resend docs and wrote `docs/resend-integration.md` (verdict, DNS, dashboard steps, gaps G1–G17, 12-step live plan). Orchestrator checked against the source pages: catch-all receiving on a verified domain; webhook carries metadata only (body via `GET /emails/receiving/{id}`); subdomain needed if the root has MX; free plan 100/day, 3 domains, 1 webhook endpoint; received mail counts toward the quota.
- Verdict: feasible on the free tier. Gaps to fix: over-quota 403 retry storm (G6), send error mapping (G10), html_format=cid + size cap (G3), SHARED_MAIL_DOMAIN docs (G9); Message-ID preservation (G12) needs the live test.
- N1 started: the gap fixes, webhook ack-then-process, a cloudflared tunnel compose service, `live-resend.ts`.
- Created Resend domain `nanitecom.itsvikrant.tech` through the API (id 610a155e-009e-4433-b0bb-d62b8d4691ec, ap-northeast-1, sending+receiving, tracking off). DNS records in `docs/resend-dns-records.md`; waiting for Vikrant to add them.

## 2026-11-06: N1 Resend gaps fixed
- G6 terminal fetch errors (over quota -> dropped, 200); G3 html_format=cid, 4 MiB fetch cap, 64 KiB text cap; G10 send error mapping (quota 429, rate limit one retry, unverified domain 502, config 503), failed sends no longer count; G9 warning + docs; G17 fake provider uses real Resend shapes.
- Webhook now acks in 16 ms (was ~7.5 s) and processes in the background, with a recovery sweep (5 attempts). `WEBHOOK_SYNC=1` for the live scripts.
- Tunnel service (cloudflared 2026.10.2, profile tunnel); `live-resend.ts` (--create-domain/--verify/--check/--send-test/--wait-inbound).
- Verified: lint, typecheck; api 176 (+3), db 13; e2e 31/31 retries=0.

## 2026-11-06: commit Phase 5 (API)
- 12 commits 5cedccc..650b5f1: db markSendFailed/findMailboxById, then the API (env/health, mail providers, Arkiv port, inbound, agent API, auth, agents, mailbox, outbound, wiring, scripts). No real keys in any file (checked against .env). Phase 6 (web, 9 commits) is due about 20 minutes later.
- Resend domain nanitecom.itsvikrant.tech verified (DKIM, SPF MX/TXT/CNAME, receiving MX).

## 2026-11-06: real Resend wiring
- `.env` backed up (gitignored `.env.bak-*`). Cloudflare quick tunnel `nanite-tunnel` -> `nanite-api-live:4000` (DB nanite_live): https://autumn-clark-position-garlic.trycloudflare.com
- Resend webhook created through the API: id 5b03d342-19ea-4d5e-880b-957119b45155, event email.received, endpoint <tunnel>/webhooks/resend. Signing secret written straight into `.env` (never printed); FAKE_RESEND_CONTENT=0, FAKE_RESEND_SEND=0. Health through the tunnel OK.
- P1 started: agent `mail.nanitedemo` (real address), allowlist = Vikrant inbox, ENS records, token in gitignored file, signed self-test through the tunnel.
- P1 part 1: agent mail.nanitedemo.nanitecom.eth (mail.nanitedemo@nanitecom.itsvikrant.tech), deploy-resolver 0x4f5e0f6b…8b5a, register 0x700add42…13b8, grant 0xf9b9b93a…8569, signer 0xc9ed52aa…0c77 + 0xaef0fff2…232e (one extra publish), policy 0x96fb4d17…467d; allowlist = Vikrant Gmail, limit 10. The webhook self-test through the tunnel passed (unknown address dropped, 200, no loop). Waiting for a real email from Vikrant.
- Vikrant: custom domain REQUIRED in onboarding; `user_domains` table approved. T3.6 added; Q1 started.
- FIRST REAL INBOUND EMAIL: Vikrant Gmail -> mail.nanitedemo@nanitecom.itsvikrant.tech. Resend webhook through the tunnel (200 in 34 ms), body fetched from the Resend receiving API, stored on Arkiv as type otp (1 entity), event msg_3LiHN6n2WBw1bbRUsLbh22a6EGN. P1 part 2 started: decrypt, agent API, reply to Vikrant (threaded, signed), header check.
- Real round trip: the inbound entity 0x0e9d5017…699f (otp) decrypts for the user and the agent (from = Vikrant Gmail, messageId present, Arkiv raw = ciphertext only). The agent reply went through Resend: provider id 01a1ae8f-5256-745d-88c9-3ab4ce012c0e, last_event delivered, signature signed, sent copy 0xc90059b5…2618 decrypts.
- G12 confirmed: Resend/SES REPLACES our Message-ID (ours <141635a2…@nanitecom.itsvikrant.tech>, delivered <010601a1…@ap-northeast-1.amazonses.com>). The v2 signature covers Message-ID, so verification against the delivered mail will fail, and inbound replies will reference the SES id. Fix needed. Resend GET /emails does not return custom headers; checking X-Nanite-* needs Gmail "Show original".
- Vikrant Gmail "Show original" of the agent reply: inbox (not spam), same thread; In-Reply-To/References = his Gmail message id; X-Nanite-Agent/Date/Sig-Version/Signature kept; Message-ID replaced by SES. R1 started: signature v3 over our own `X-Nanite-Message-Id`, store the real provider Message-ID for reply threading, prove the delivered v2 signature with the original id.

## 2026-11-06: commit Phase 6 part A (web foundations)
- 5 commits 14a14ad..6ef6e78: shadcn primitives, design tokens/theming, Nanite components, style book, home page. Session/keys, onboarding, agents and dashboard/inbox deferred: Q1 is editing lib/api.ts, onboarding/* and dashboard-view.tsx.

## 2026-11-06: R1 signature v3 + provider Message-ID
- Proof: the delivered v2 signature verifies with our original Message-ID (valid, signer 0x4EA6…7Ae6) and fails only with the SES id, so only the signed Message-ID line was wrong.
- v3: signs `X-Nanite-Message-Id` (our id, kept by Resend), Sig-Version 3; the API no longer sets Message-ID. The verifier handles v3 and legacy v2 (with a hint). After a send the API fetches the real SES Message-ID (GET /emails/{id}, at most 3 s) into the encrypted sent copy (meta.messageId, naniteMessageId); the sent copy threadId = HMAC of the thread root, so replies link up with no new plaintext.
- Verified in Docker: ens 44 (+7), crypto 24, api outbound/limits/resend 76/76. The live API still runs v2 until restarted. The e2e failures are in Q1 domain.spec (in progress).

## 2026-11-06: Q1 T3.6 custom domain onboarding (first pass)
- Migration 0003 (user_domains only). Domain check/create/view/verify/delete, a background verifier (15 s/10 min, 2 min/2 h, 15 min/72 h, auto verify when the DNS is all found), webhook domain.* events, wizard step 04 domain with live per-record status. Verified: lint, typecheck; api 223/224 (1 flaky: resend-integration crash-recovery test), e2e 37/38 (1 flaky: aborted RSC prefetch in agents.spec).
- Vikrant REVISED: domain optional (choice: own domain recommended, with a 72 h DNS note, or the fast route on the shared domain); sent back to Q1 together with the two flaky tests.

## 2026-11-06: T3.6 revised to optional + live API updated
- Q1: step 04 is a choice (own domain recommended, with a 72 h note and Continue for now; or start now on the shared domain); a dashboard Mail domain card to add one later; complete never needs a domain; agents use the user domain only once verified. Flakes fixed at the root (startup sweep age check; ignore only ERR_ABORTED on ?_rsc= prefetch).
- Verified: lint, typecheck; api 226 (+3), db 13, crypto 24, arkiv 28, ens 44, mcp 3; e2e 41/41 retries=0; screenshots reviewed.
- Ops: migration 0003 applied to nanite_live; nanite-api-live restarted on the new code (signature v3, provider Message-ID, domains), tunnel URL unchanged, health OK; Resend webhook 5b03d342 now also subscribed to domain.created/updated/deleted.
- Vikrant: the real second-domain test moves to the end. S1 started: a headed Playwright browser in Docker (Xvfb + x11vnc + noVNC on 127.0.0.1:6080), a slowMo demo run of the flows, and a browse mode left open.

## 2026-11-06: commit Phase 6B
- 11 commits 9378f7c..4e1ad31: crypto meta fields, ens signature v3, db user_domains, outbound Message-ID fix, inbound startup sweep fix, custom domains, live Resend records, web session/keys, onboarding (domain choice), add-agent/settings, dashboard/inbox. apps/ and packages/ are now fully committed. No secrets (checked against .env).

## 2026-11-06: S1 headed browser
- `browser` service (profile headed): Xvfb + x11vnc + noVNC on 127.0.0.1:6080 only; headed suite 23/23 at slowMo 200 (500 makes the axe-heavy agents tests time out); headless suite 41/41 unchanged; browse mode with the mock wallet left open on the home page. Process slip: some files written with shell heredocs.
- Vikrant: the "Open the style book" CTA must not be visible to users. T1 started: home CTAs (Get started / Sign in / Open dashboard), /styleguide gated (dev, or NEXT_PUBLIC_SHOW_STYLEGUIDE=1), example addresses moved to the real shared domain.
- T1 done: home shows Get started / Sign in (Open dashboard with a session); no user-facing /styleguide link; /styleguide gives 404 in production unless NEXT_PUBLIC_SHOW_STYLEGUIDE=1; example addresses use alex.vikrant@nanitecom.itsvikrant.tech. Baselines regenerated (the baseline project CLI was fixed). Verified: lint, typecheck, e2e 41/41, home screenshot reviewed.

## 2026-11-06: commit Phase 7 (tests, infra, docs)
- 8 commits dd96408..8e823fb: gitignore, web home actions, e2e suite, headed browser, compose + env example, CI, README/ENS/Resend docs, decisions/task plan. No secrets (checked against .env). Only Phase 3 files remain uncommitted (on hold).
- Vikrant: build the self-hosted agent kit (local keygen, local decrypt, local signing verified by the API) + MCP fixes (send_email, get_latest_otp, hosted /mcp, real agent-endpoint). T3.7 added; U1 started.

## 2026-11-06: U1 T3.7 self-hosted agent kit + MCP
- `nanite-mcp keygen` (X25519 + secp256k1 key file, mode 600, prints only the public key and signer address; optional Argon2id passphrase) and `rotate-signer`. MCP local mode (`NANITE_AGENT_KEY_FILE`): fetch ?raw=1, decrypt and extract locally, self-sign v3. Tools in both modes: list_inbox, get_email, wait_for_email, get_latest_otp, send_email.
- API: self-agent send verifies the client v3 signature against fresh nanite.signer (uuid = send_log id, so reuse is blocked; date within ±5 min), client-supplied threading; GET /v1/me; self signerAddress publish/rotate; hosted Streamable HTTP POST /mcp (token auth, self agents get 403); agent-endpoint[mcp] = API_PUBLIC_URL/mcp; update-agent-endpoints.ts (not applied).
- Shared extract/sendsig moved to packages/crypto (@nanite/ens now depends on @nanite/crypto). No schema change.
- Verified in Docker: install, lint, typecheck; api 250 (+3), crypto 35, ens 45 (+7), mcp 19, db 13, arkiv 28; e2e 43/43 retries=0; screenshot reviewed. Not live-tested yet; nanite-mcp is not published to npm.
- Live API restarted on the T3.7 code. The quick tunnel had expired ("Tunnel not found"); new tunnel https://scene-polyphonic-consolidation-patricia.trycloudflare.com, Resend webhook 5b03d342 repointed through the API (PATCH endpoint), 4 events kept, health OK. V1 started: live self-hosted check (keygen, agent kit, nanite.signer, refusal checks).
- Vikrant: build expiry control; normal mail default 2 days. T3.8 added; W1 started. V1 part 2 (self-hosted live) waiting for Vikrant email to kit.nanitedemo.

## 2026-11-06: commit Phase 8 (self-hosted kit + MCP)
- 10 commits ce5eda6..31677a9. No secrets (checked against .env and the self-hosted token). Slip: a594d45 includes W1 in-progress retention code in packages/ens/src/service.ts (imports uncommitted policy.ts helpers); history builds again after the T3.8 commit.
- 11:5x W1 (T3.8) stopped on the 5-hour usage limit; resumed at 12:00 IST with SendMessage, continuing from the MCP tests.

## 2026-11-06: W1 T3.8 verified + commit Phase 9
- Verified: lint, typecheck; api 273 (+3), arkiv 30, ens 52, mcp 22, crypto 35, db 13; e2e 47/47 retries=0; Keep popover screenshot reviewed. Note: reply-only now only sees senders whose mail is still on Arkiv (2-day default). Process slip: W1 used a host heredoc for one test.
- 7 commits 5b10a8c..af913b2 (ens retention records, arkiv 2-day default, db extend counting, api lifetimes + extend, mcp extend_email, web Keep + Retention card, docs). The a594d45 gap is repaired; HEAD equals the verified tree for apps/ and packages/.
- Self-hosted live: Vikrant Gmail -> kit.nanitedemo@nanitecom.itsvikrant.tech, webhook 200 in 51 ms, stored as otp (event msg_3LisHv0tOzH4Q10joOA05osRo2p). V1 part 2 started: local MCP decrypt, self-signed reply, header verification.

## 2026-11-06: self-hosted live check part 2 (V1)
- Server: GET without raw = 409 self_custody; ?raw=1 = ciphertext only; no subject/sender needle in server or Arkiv responses. Local MCP (stdio, key file) decrypted subject/body/OTP on the agent machine with content untrusted. Entity 0x714da347…bb24.
- Self-signed reply via the send_email tool: the API verified the client v3 signature against live nanite.signer and sent it; provider 01a1afa6-d92f-7980-9d02-8ca40089feca delivered; sent copy 0x8e335715…c528. The kit header capture failed (hook in the wrong process), so the final check needs the Gmail headers.
- Bugs found live: (1) the launcher dropped CLI args (fixed, committed); (2) local mode missing await ready() in bin.ts (fixed, not committed yet). Follow-up: a smoke test that spawns the real launcher in local mode.
- FINAL self-hosted check from the Gmail "Show original" of the kit reply: inbox, same thread (In-Reply-To/References = Vikrant Gmail id), DKIM pass (nanitecom.itsvikrant.tech + amazonses), SPF pass, DMARC pass; X-Nanite-* v3 kept (X-Nanite-Message-ID kept, Message-ID replaced by SES as expected). verify-mail-signature.ts against live ENS: valid, signer 0x5B0A…8A11 (= keygen address on the agent machine), reason ok. Tampered subject: signer_mismatch. T3.7 live-verified end to end.

## 2026-11-06: T4.3 deployment started
- docs/deployment.md written: Vercel web at nanite.itsvikrant.tech, API + Postgres + Caddy on Lightsail (2 GB/2 vCPU Ubuntu) at api.nanite.itsvikrant.tech (same site for the SameSite=Lax cookie), images from GHCR via GitHub Actions, fresh prod DB with new master/sender secrets, operator keys copied by scp (never pasted), Resend webhook moved to prod, nightly pg_dump.
- X1 started: Dockerfile, .dockerignore, prod compose, Caddyfile, env example, backup/deploy scripts, GHCR workflow, TRUST_PROXY, live-resend --webhook-endpoint, local proof.
- X1 done: apps/api/Dockerfile (node:22.23.3-slim by digest, non-root, migrate then start, healthcheck), .dockerignore, deploy/{docker-compose.prod.yml,Caddyfile,Caddyfile.local,.env.production.example,backup.sh,deploy.sh}, .github/workflows/api-image.yml (actions pinned by SHA), TRUST_PROXY client IP + 60/min per-IP limit on /auth, live-resend --webhook-endpoint. Local proof: migrations, /health over Caddy HTTPS, uid 1000, 508 MB image with no secrets/tests, idle api 104 MiB / db 49 MiB / caddy 14 MiB, backup ok. Orchestrator check: lint, typecheck, api 280 (+3).

## 2026-11-06: guides, Arkiv audit, pitch research
- Y1: docs/user-guide.md + docs/demo-script.md, every step validated (Playwright/curl/code) with a validation table and screenshots.
- Y2: Arkiv friction audit with evidence (arkiv/friction-evidence.md, repro scripts), rewrite friction.md from validated items only; user-reported U1 (no contains/substring), U2 (no aggregates), U3 (no arithmetic/variables), U4 (slow site / Cloudflare 522) to be verified; refresh reach/why/how/schema for the current product; README AI-use note. Blocks the Phase 3 commit.
- Y3: docs/pitch-research.md (problem evidence, competitors such as AgentMail, Web3 mail, XMTP, ENS agent standards; comparison table; risks) with sources. Orchestrator writes the pitch after.
- Y3 done: docs/pitch-research.md. Orchestrator verified the AgentMail $6M seed (General Catalyst, 2026-03-10) and its pricing page (free 3 inboxes/100 per day, MCP, SOC 2 on Startup, no encryption mentioned); "500+ B2B customers" has no primary source, so it is not used. docs/pitch.md written (one-liner, problem, USP, competitors, audience, judge Q&A, per-prize presentation, 30 s / 2 min / 4 min tracks, slides).

- Y1 done: docs/user-guide.md (46 steps: 36 validated, 5 partly, 5 code-read), docs/demo-script.md (21 rows: 11 validated, 5 partly, 5 not), 33 screenshots in docs/guide-shots, e2e/tests/guide-shots.spec.ts. Confirmed: users never pay gas. Bug: rotate-signer fails (ready() after the rotate branch in bin.ts); doc drift (5 vs 6 MCP tools, mail ~6 months vs 2 days). Seeded demo data cannot be used on prod (FAKE flags ignored), so prod demo data must be real. Slip: one stray npx vitest on the host. Z1 started (fix + real-launcher smoke test + docs).
- Z1 done: bin.ts awaits ready() before every command; packages/mcp/test/launcher.test.ts spawns the real launcher (keygen mode 600 with no private keys printed, rotate-signer keeps the encryption key, local + hosted stdio handshake lists 6 tools, missing env exits non-zero). Docs: 6 tools, 2-day default. Orchestrator verified: lint, typecheck, mcp 27/27; marked the guide bugs fixed.

## 2026-11-06: Y2 Arkiv audit verified by the orchestrator
- Y2: friction.md rebuilt from validated items only, with evidence (arkiv/friction-evidence.md) and repro scripts (scripts/arkiv/repro/); reach/why/how/schema refreshed; README "How we used AI" + writer wallet + query.
- Orchestrator reproduced live on Rabdi: STARTSWITH works; CONTAINS and LIKE give -32001 "expected a comparison operator (= < <= > >= BETWEEN STARTSWITH)"; arithmetic u64(a)-u64(b) "expected digits after the sign"; now() "expected a value"; GROUP BY rejected; != gives -32002 suggesting NOT (attr = value), and NOT (...) gives -32603 "store: NotImplemented"; select.count works (0x10 = 16). Docs ne page documents ne/not, SDK 1.0.1 (npm latest) exports neither. Also: str() needs single quotes (-32003).
- U4 (Cloudflare 522): no evidence in our records; not in friction.md; question for Vikrant (host + date). reach.md has a TODO for the post-Mumbai commitment.
- Vikrant created user pumpxyz + agent alex on the DEV stack (DB nanite). Mail to alex.pumpxyz@nanitecom.itsvikrant.tech did not arrive: the quick tunnel had expired again and pointed at nanite-api-live (DB nanite_live). New tunnel https://super-dividend-type-thumbs.trycloudflare.com -> dev api:4000; Resend webhook repointed. Resend retries failed deliveries (~28 h).
- On Vikrant request: sent one email from alex.pumpxyz@nanitecom.itsvikrant.tech to his Gmail via POST /v1/emails/send (dev API, temporary token with a 15-minute expiry issued with issueAgentToken, never printed). 200 sent, signed, provider 01a1b09c-17f2-7e58-8276-adbaebadf095, sent copy 0x8920a453…0410. Allowed by reply-only (he had emailed alex).

- 2026-11-06: Inbox view redesigned as a split-view mail client (inbox-view.tsx, nanite/inbox-row.tsx, mail.ts carries meta.to for sent). Lint/typecheck pass; Playwright 50/50 incl. axe. Guide shots 50-54 regenerated.

- 2026-11-06: One-off send findleads.vikrantsingh -> external recipient after user changed send policy; 200 signed, provider id 01a1b0d5-cee3-7d85-84bf-6a2ec4067a62, sent entity 0x41e7d9c7...4fcf. Temp 15-min token; user-pasted token not used.

- 2026-11-06: One-off send alex.pumpxyz -> external recipient after user updated send policy; 200 signed, provider id 01a1b103-d415-726e-a559-16980ab69f01, sent entity 0x5c19b426...8fea. Temp 15-min token; pasted token not used.

- 2026-11-06: One-off send alex.pumpxyz -> owner Gmail; 200 signed, provider id 01a1b105-ed00-70fe-a33d-33ec5a59600e, sent entity 0xc7c99698...1ef7.

- 2026-11-06: docs/pitch.md rewritten around the one-person company and agent identity on ENS (four identity signals per mail, public records, control and encryption layers). Claims checked against README, packages/crypto/README.md and packages/ens; planned items marked "next" (public verify page, role picker).

- 2026-11-06: Pitch council (ENS judge, Arkiv judge, pitch coach; Opus, read-only, fact-checking against code). Scores: R1 6.5/6/6.5, R2 8/8/8.5, R3 9/9/8.5, R4 coach 9. Fixed overclaims: live URL (now next), hosted-agent decryption, public metadata, Keep cap, allowlist under reply-only (send.ts:137-146; script now uses the reply-to-sender 200). docs/pitch.md now opens with a timed 2-minute script and a pre-stage checklist.

- 2026-11-06: Dashboard agent avatar replaced by AgentMascot (original pixel bot, seeded variants, 5x5 identity glyph on chest, idle/hover/status animations, reduced-motion static) + "AI agent" label. Lint/typecheck pass; Playwright 50/50 incl. axe. Reviewed 1440 dark, 390 dark, styleguide dark+light.

- 2026-11-06: Hero Spline scene + layout move reverted at Vikrant's request (page.tsx, home-composition.tsx, .env.example, docker-compose.yml, apps/web/package.json restored; hero-scene*.tsx deleted; @splinetool/runtime removed from lockfile). Typecheck; guide-shots + smoke 9/9 pass; 01-home.png regenerated.

- 2026-11-06: docs/how-it-works.md written (Opus, code-checked; spot-checked agent keygen claim: hosted agents get a random server keypair, not seed-derived). Pitch Q&A fixed: only hosted agents always get a signer. Started: MCP E2E verification + docs/mcp.md; demo kits (Reddit via Claude Code + Nanite HTTP MCP + Playwright MCP on headed browser, human solves CAPTCHA; self-hosted stdio kit demo). npm publish deferred (Vikrant).

- 2026-11-06: MCP verified E2E (Inspector CLI 1.0.3 + SDK 1.32.2, hosted HTTP + stdio + local): all tools PASS incl. real inbound OTP, threading, policy 403, auth 401s, rate limit 429, self_custody; no code bugs; README Claude Desktop config fixed; docs/mcp.md written. 4 real sends. Process slip: subagent ran one python3 text edit on the host. Demo kits in demo/ (reddit, self-hosted) + compose: Playwright MCP 0.0.83 on headed browser (127.0.0.1:8931), kit/kit-keygen services; validated except live Reddit, real mail and claude CLI.

- 2026-11-06: Arkiv docs council (Arkiv judge, plain-English editor, fact-checker; Opus) over 4 rounds. Final: friction 9/9.5/9, why-arkiv 9/10/8.5 (the 2 blocking lines then applied verbatim), reach 5 as written (8.5 once founder items filled)/9.5/9, build-notes 9.5 (fact). Fixed: auth TTLs, plaintext seed, repro citations, size units, overclaims on expiry/creator/extension. ENS notes moved to arkiv/build-notes.md; docs/ens.md link updated. Open founder items: TODO commitment, user count, deploy, report friction upstream.

- 2026-11-06: Commits Phases 10, 11, 3, 12, 13 done (d7ed1a8..667257b, 35 commits). Pre-checks: lint 0, typecheck 0, 437 tests pass, secret scan clean. No Claude attribution.
