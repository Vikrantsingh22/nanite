# Nanite: Task Plan (phases and tasks)

Last updated: Nov 5, 2026. Context files: `claude/nanite-status-and-decisions.md` (process, security rules, confirmed facts) and `claude/nanite-project-summary.md` (full design).

Every task runs in its own new conversation with Claude Code. Total budget is about 40 build hours; time boxes below add up to that. When a time box runs out, stop, write what is left, and cut scope; do not borrow time from the next task. The prize criteria that matter most are Arkiv (writes, reads, schema, docs, friction) and ENSv2 (central to the product, working demo, live link).

## Status

Update this table at the end of every task (Todo / In progress / Done / Cut).

| ID | Task | Box | Status |
| --- | --- | --- | --- |
| T0.1 | Wallets and Sepolia name | 0.5h | Done |
| T0.2 | Repo scaffold, stack, hosting | 2h | Done (public GitHub repo and push still to do) |
| T0.3 | Arkiv spike | 2h | Done |
| T0.4 | ENS spike on Sepolia | 3h | Done |
| T0.5 | API service scaffold (`apps/api`) | 0.5h | Done |
| T1.1 | Postgres schema and migrations | 1.5h | Done |
| T1.2 | Crypto library | 3h | Done |
| T1.3 | Inbound pipeline: Resend to Arkiv | 4h | Done (proven with signed fake events + real Arkiv writes; a real Resend email waits on Vikrant's domain + API key) |
| T1.4 | Arkiv schema and query layer | 2h | Done |
| T2.1 | ENS service module | 3h | Done |
| T2.2 | Agent records and revoke | 2h | Done |
| T3.1 | Sign-in, key setup, onboarding | 4h | Done (mocked wallet; real wallet + Sepolia claim untested) |
| T3.2 | Add-agent flow | 2h | Done (live E2E passed) |
| T3.3 | Dashboard and inbox | 3h | Done (live E2E passed; inbound HTML not stored yet) |
| T3.4 | Agent API, tokens, MCP | 3h | Done |
| T3.5 | Outbound send, gated by ENS policy | 2.5h | Done (signing B + threading + quota; dashboard toggle done) |
| T3.6 | Custom domain onboarding (enter domain → DNS records → auto verify) | 3h | Done (optional; fakes; live user-domain test pending) |
| T4.1 | OTP expiry and demo data | 1.5h | Done (live: OTP gone at its expiry block; seed-demo.ts) |
| T4.2 | Arkiv docs and README | 2h | Mostly done (AI-use note + web claims to confirm after T3.3) |
| T4.3 | Deploy and live link | 1.5h | Todo |
| T4.4 | Video, QA, submission | 2h | Todo |
| S1 | Stretch: Swarm for attachments | 3h | Only if time remains |
| S2 | Stretch: self-hosted agent container | 3h | Only if time remains |
| S3 | Stretch: raw `.eml` and DKIM check, ENSIP-25 | 2h | Only if time remains |

## Phase 0: Foundations (7.5h)

| ID | Goal | Deliverable | Done when |
| --- | --- | --- | --- |
| T0.1 | Wallets and name ready | Operator wallet (Sepolia only) and 2 or 3 test user wallets funded with Sepolia ETH; addresses in `docs/wallets.md` (addresses only, never keys) | Owner has registered `nanitecom.eth` on Sepolia (done); operator and test addresses recorded |
| T0.2 | Repo ready for fast work | Public repo with open-source license, `README` stub, `CLAUDE.md` (links to these project docs, security rules, commands), monorepo layout, stack chosen (suggest TypeScript, Next.js app, Node API, Postgres, viem, `@arkiv-network/sdk`), Docker Compose setup for every service (app, API, Postgres), `.env.example`, `arkiv/` folder with empty `schema.md`, `friction.md`, `reach.md`, `why-arkiv.md`, `how-you-use-arkiv.md`; hosting target chosen | `docker compose up` starts the stack; CI or a lint step passes (run in Docker); the stack and hosting choice is written in `CLAUDE.md` |
| T0.3 | Know how Arkiv really behaves | Script that writes and reads one entity on the Arkiv testnet; findings on payload size limit, expiry, query syntax, and whether another key can write on a user's behalf (delegation); a decision on who writes entities (operator, user wallet or derived writer key) | Findings recorded in `arkiv/friction.md` and `claude/nanite-status-and-decisions.md`; the writer-wallet decision is made |
| T0.4 | Know how ENSv2 really behaves | Script or browser-signed transactions on Sepolia that: deploy a UserRegistry for `nanitecom.eth` via the factory, call `setSubregistry` on the `.eth` registry, grant the operator `ROLE_REGISTRAR \| ROLE_RENEW`, have the operator register one test name, deploy one resolver proxy with a text record and a key-scoped setter role for a test agent wallet | Every call works or the failure is documented with the fallback chosen; confirmed ABIs saved to `contracts/abi/`; addresses saved to config; open ENS items in the status file are closed |
| T0.5 | Backend service for local development | `apps/api` (Node + Hono, pinned) in the workspaces with `/health` (DB check via `packages/db`); an `api` service in docker-compose (127.0.0.1:4000); `apps/web` reads `NEXT_PUBLIC_API_BASE_URL`, and the Next `/api/health` route moves to the API; CORS limited to the web origin locally | `docker compose up` runs web + api + db and the web app reaches the API; lint, typecheck and e2e stay green |


T0.4 notes: owner steps are signed in the browser wallet (the owner key never goes into a script). Read the real ABIs from Sepolia Etherscan or the Explorer for `ETHRegistry`, `UserRegistryImpl`, `PermissionedResolverImpl` and `VerifiableFactory`. If the operator cannot call `register()` directly, record it and use the next best role design. Fallback if registries do not work in time: subnames as plain resolver records.

## Phase 1: Core backend (10.5h)

| ID | Goal | Deliverable | Done when |
| --- | --- | --- | --- |
| T1.1 | Operational database | Postgres schema and migrations for `users`, `user_keys`, `domains`, `mailboxes`, `agents`, `api_tokens`, `webhook_events`, sessions/nonces (see the Data split section of the summary) | Migrations run clean on an empty database; seed script creates one user and one agent |
| T1.2 | Crypto library (shared by browser and server) | Package with: envelope encrypt/decrypt of an email, sealing the content key to multiple recipients, X25519 keypair, wallet-signature key wrapping (HKDF), recovery-code wrapping, seed and per-agent derivation (wallet and encryption key), passphrase fallback | Unit tests pass for round trips: user decrypts, agent decrypts, a wrong key fails, recovery code restores the key, derivation is deterministic |
| T1.3 | Inbound pipeline | Webhook endpoint for Resend `email.received` with signature verification; fetch body via Receiving API; look up recipient in `mailboxes` (drop unknown); classify as OTP or conversation; encrypt; write Arkiv entity with expiry; dedupe through `webhook_events`; retries | A real email sent to a test address produces an Arkiv entity with encrypted fields and correct plaintext index fields; sending it twice does not duplicate; unknown address is dropped; no content in logs |
| T1.4 | Arkiv schema and read layer | `arkiv/schema.md` finished (entities, queried fields, owners, expiries per email type) and a typed read layer: inbox by agent/type/time, latest OTP, entity by id | The README query runs against testnet and returns the test email; schema file matches the code |

## Phase 2: Identity on ENSv2 (5h)

| ID | Goal | Deliverable | Done when |
| --- | --- | --- | --- |
| T2.1 | ENS service module | Server module (operator wallet) with `createUserName(username, userWallet)` (deploys the user's registry, registers the name, grants the user root roles) and `createAgentName(user, agent)` (deploys a resolver proxy with initial records, grants the agent key-scoped setter roles, registers the agent name in the user's registry); idempotent and resumable (deterministic proxy addresses) | Running both against Sepolia for a test user and agent gives names that resolve through the Universal Resolver with the right `addr` and `email` records |
| T2.2 | Records, permissions, revoke | Records per agent: `addr`, `email`, `nanite.pubkey`, ENSIP-26 `agent-context` and `agent-endpoint[mcp]`; send-policy records `nanite.send`, `nanite.send-allow`, `nanite.send-limit` set at creation (default `reply-only`), settable only by the user and operator; the agent wallet can edit only its own allowed keys (and a write to another key, including the send-policy keys, fails); revoke removes setter roles and optionally unregisters | A test shows the agent can set an allowed text record, is rejected for another record and for `nanite.send`, and after revoke is rejected for both |

## Phase 3: Product (12h)

| ID | Goal | Deliverable | Done when |
| --- | --- | --- | --- |
| T3.1 | Sign-in, key setup, onboarding | SIWE sign-in; browser key setup (keypair, wallet-signed wrapping, double-sign check, passphrase fallback, recovery code shown once and confirmed); username claim that calls T2.1; resumable onboarding state | A new wallet goes from sign-in to a claimed `username.nanitecom.eth` and unlocked keys; refresh resumes correctly; the server never sees the private key, seed or recovery code |
| T3.2 | Add-agent flow | Add agent: derive wallet and encryption key from the seed in the browser, create mailbox row, call T2.1 for the agent name, show address, ENS name and token once | New agent appears with its ENS name and email address in one click; the first email to it is routed |
| T3.3 | Dashboard and inbox | Three screens: agents list, one agent's inbox (decrypted in the browser from Arkiv), OTP view; plus a link to the Arkiv explorer entity | A real email shows up decrypted in the right inbox; the Arkiv explorer shows only ciphertext for it |
| T3.4 | Agent API | `GET /v1/inbox`, `/v1/emails/{id}`, `/v1/otp/latest`, `/v1/emails/wait`; per-agent token (hashed); rate limit; bodies labelled untrusted; OTPs and links extracted; small MCP wrapper | A script using only an agent token fetches its email and OTP; a token cannot read another agent's mail; a revoked agent gets 401 |
| T3.5 | Agents send email, permitted by ENS | `POST /v1/emails/send` (agent token); before each send, resolve the agent's `nanite.send` / `nanite.send-allow` / `nanite.send-limit` fresh via the Universal Resolver and enforce them (`off`, `reply-only`, `allowlist`, `any`; daily cap); send through Resend from `agent@domain` with `In-Reply-To`/`References`; header `X-Nanite-Agent: <ens name>` plus an agent-wallet signature; encrypted sent copy on Arkiv (`type = "sent"`, operator creates and transfers to the user); send log without bodies; dashboard toggle that updates the ENS record | With `nanite.send = off` the API returns 403; after the user sets `allowlist` with one address, a send to it succeeds and one to another address gets 403; the agent's own wallet cannot change `nanite.send`; the sent copy appears in the inbox decrypted; the signature verifies against the agent's ENS name |

## Phase 4: Finish (7h)

| ID | Goal | Deliverable | Done when |
| --- | --- | --- | --- |
| T4.1 | OTP expiry and demo data | OTP entities with a short expiry that disappear from queries; seed script for the demo user and agents | Sending an OTP shows it, then it is gone after expiry without manual cleanup |
| T4.2 | Arkiv docs and README | `arkiv/schema.md`, `friction.md`, `reach.md`, `why-arkiv.md`, `how-you-use-arkiv.md` answered with links, numbers or a runnable query; README with writer wallet addresses, one runnable query, setup steps, license, and an AI-use note | Every judged criterion has a file with concrete evidence; README query works from a clean checkout |
| T4.3 | Deploy and live link | Production build files first: a multi-stage `api` Dockerfile, `docker-compose.prod.yml` (api, db with nightly `pg_dump`, caddy for `api.<domain>`), a GitHub Actions job pushing the image to GHCR, and the Vercel rewrite or CORS decision. Then: frontend on Vercel; API, Postgres and Caddy on the Lightsail $12 instance (static IP, firewall: only 80/443 and SSH from Vikrant's IP), pulled from GHCR; DNS for the app, `api.` and the Resend MX; the Resend webhook pointed at `https://api.<domain>`; server secrets only in the VM env; backups (nightly `pg_dump` and a Lightsail snapshot) enabled; the live demo link in the README | The demo script runs end to end on the live link, from a phone email to a decrypted inbox |
| T4.4 | Video, QA, submission | Backup demo video; full run of the demo script; submission text; checklist: public repo, license, live link, writer wallets, no keys in git | Submission is ready to send; a fresh clone builds |

## Cut order (if time runs short)

Cut from the bottom, keep the top:

1. Arkiv writes and reads with expiry (T1.3, T1.4, T4.1)
2. ENSv2 names with per-agent permissions and revoke (T2.1, T2.2)
3. Onboarding, add-agent, inbox (T3.1 to T3.3)
4. Agent API (T3.4), then outbound send gated by ENS (T3.5)
5. Docs and live link (T4.2, T4.3), which are required and must not be cut
6. Stretch tasks S1 to S3: only after Phase 3 is done

If T0.4 fails, use the fallback (subnames as plain resolver records) and say so in `why-arkiv.md` and the README; do not let it block Phase 1.

## Starting a task in a new conversation

Paste this into the new Claude Code conversation:

> Task <ID> of Nanite (<title>), time box <N> hours. First read the project docs `claude/nanite-status-and-decisions.md`, `claude/nanite-task-plan.md` and `claude/nanite-project-summary.md`. Do only this task, using the goal, deliverable and done-when in the task plan. Follow the security rules in the status file. Do not start other tasks. At the end: update the status table in the task plan, write handoff notes (what is done, what is not, deviations from the plan, the next step), and append any friction you hit to `arkiv/friction.md`. Stop at the time box and tell me what is left.

## Handoff note format (end of each task)

- Task ID, outcome (Done / Partly / Cut), real time spent
- What now works and how to run it
- Decisions made or changed (add them to the status file)
- Open problems and what the next task needs to know
- Friction found (also in `arkiv/friction.md`)

## Handoff notes

### T0.1 + T0.4 (Sepolia ENSv2 naming), 2026-11-05

- **Outcome:** Done, within the 3.5h box. The step-by-step record is in `docs/logbook.md`; every tx hash is in `config/sepolia-deployments.json`.
- **What works:**
  - `nanitecom.eth` on Sepolia points to our UserRegistry `0xD2BE…C786`. The operator can register names under it, and `t04test.nanitecom.eth` resolves through UniversalResolverV2 with addr, `email`, `nanite.pubkey` and `agent-context`.
  - Agent 0 can update only `agent-context`; other keys and other agents revert.
  - Run `docker compose run --rm tools npx tsx scripts/ens/verify.ts` (read-only; `--write` sends the agent-0 write). Owner transactions go through `docker compose up -d signer` at http://localhost:5173 and `scripts/ens/owner-tx.ts`.
- **Decisions:**
  - Deploy the resolver before registering.
  - Each agent gets its own resolver (setter roles are per key, not per name).
  - The test user got D3.
  - All are written into the status file, which now lists the confirmed ENSv2 behaviour and closes the open ENS items.
- **Deviations:**
  - Step 6 (wallets) ran before the owner signatures so funding could happen in parallel.
  - Steps 9 and 10a were swapped (approved by Vikrant).
  - Part of T0.2 (Docker skeleton, CLAUDE.md, ignore files, arkiv stubs) was done here because the spike needed it.
  - The orchestrator's re-run of `verify.ts` sent one extra harmless agent-0 write before it was made read-only.
- **For the next tasks:**
  - **T2.1:**
    - Clamp child expiry to the parent's and reject expiry <= now.
    - Build role bitmaps from an allowlist (`ROLE_REGISTRAR` can mint any roles).
    - Use labelhash as `anyId`; don't cache tokenIds.
    - Decide the real user role set and whether users get `ROLE_RENEW`.
    - Build the two-level design (each user's own registry under `nanitecom`, agents under it).
  - **Renewal:** `t04test` expires 2026-12-05. The `nanitecom.eth` Sepolia name expires 2027-11-05.
  - **RPC:** the public Sepolia RPC can lag right after a receipt; retry reads.
- **Friction:** logged in `arkiv/friction.md` (ENS/tooling sections).

### T0.3 (Arkiv spike), 2026-11-05

- **Outcome:** Done. Over the 2h box in elapsed time, because of a network block on the Rabdi RPC and roughly 20–35 minutes waiting for faucet funds; the actual test work fit in the box. Run as 1 bootstrap agent and 4 parallel Sonnet agents (W1 size and cost, W2 expiry, W3 writer model, W4 queries), each with its own derived wallet; the orchestrator re-verified each one's key claims on chain.
- **What works:**
  - `scripts/arkiv/lib.ts` (clients, wallets, polling) and `scripts/arkiv/schema.ts` (`nanite.email.v0`).
  - Test scripts `scripts/arkiv/w1-size.ts` to `w4-queries.ts`.
  - Judge query `docs/arkiv-spike/readme-query.sh`, a plain curl pinned to `$creator`.
  - Funding via `scripts/arkiv/distribute.ts`.
  - Findings in `docs/arkiv-spike/W0.md` to `W4.md`, raw results in `docs/arkiv-spike/results/`.
- **Decisions:**
  - SDK pinned to 1.0.1, an exception to the two-week rule (older versions lack the schema API).
  - Writer model: the operator creates and transfers in one batch (confirmed by Vikrant).
  - Every query pins `$creator`.
- **For the next tasks:**
  - **T1.3:**
    - Serialize operator writes (a single-flight queue) and re-predict keys on revert.
    - Set `permissionlessExtension` on conversation mail only.
    - Reject mail over about 125 KiB of ciphertext, or chunk it.
    - Poll after writes.
  - **T1.4:**
    - Pin `$creator`; use the query patterns in `docs/arkiv-spike/W4.md`.
    - Decide `senderHash` and ID opacity.
  - **T4.1:** OTP expiry is exact to the block, so compute the countdown from `$expiresAt` (there's no event).
  - **T4.2:**
    - The README query needs long-lived demo data. Spike data expires within an hour.
    - Add `jq` to the `tools` image or decode in node.
    - Fix the quoted `addr('0x..')` comment in `docs/arkiv-spike/query.curl.sh`.
  - **Funds:** the funder keeps about 1 tGLM, and each worker wallet has about 1.4 tGLM left.
- **Friction:** merged into `arkiv/friction.md` (Arkiv section: 5 big items, 11 smaller ones, and what worked well).

### T0.2 (repo scaffold, stack, hosting), 2026-11-05 to 06

- **Outcome:** Done, apart from creating the public GitHub repo and pushing. Run as A1 (foundation), then A2 (design system) and A3 (Playwright) in parallel, plus one review round; the orchestrator re-verified everything in Docker.
- **What works:**
  - **Stack:** npm workspaces; `apps/web` on Next 16.4.2, React 19.3, Tailwind 4.3.3 and shadcn 4.22.1; Postgres 17.6 in compose; `/api/health` checks the database.
  - **Design system:** "Secure terminal" (Host Grotesk + Martian Mono, OKLCH tokens in dark and light), 35 shadcn components, 10 Nanite pattern components in `apps/web/src/components/nanite/`, the `/styleguide` style book and the home page.
  - **Playwright:** `e2e/` runs in Docker (profile `e2e`): screenshots at 4 widths, axe, console and overflow, focus, scroll and anchor checks. 18 of 18 pass, confirmed in two clean runs. The agent CLI runs via `e2e/bin/pw-cli.sh`.
  - **CI:** lint, typecheck, build and e2e typecheck. Also LICENSE (MIT), the README stub and CLAUDE.md commands.
  - **Run it:** `docker compose up -d db web`, then http://localhost:3000 and `/styleguide`; `docker compose --profile e2e run --rm e2e npx playwright test`.
- **Decisions:**
  - Vercel for frontend and backend + Neon Postgres.
  - MIT license.
  - The "Secure terminal" design.
  - Nothing runs on the host (all in the status file).
- **Deviations:**
  - **Version exceptions:** Next is 16.4.2, not the newest 16.4.5 (the two-week rule); TypeScript stays on 5.9.3 rather than the new 7.x major.
  - **Rule breaches:** three subagents and the orchestrator edited files with host `python3`/`printf` before the rule was made explicit. Prompts now require editor tools only.
  - **Possible flake:** one axe run failed while `next build` ran next to the dev server; it didn't recur in two clean runs.
- **For the next tasks:**
  - **Workflow:**
    - Run `next build` only when the dev server is stopped, or in CI.
    - The dev server needs `allowedDevOrigins: ["web"]` for Playwright, and it's set.
    - The command palette demo mounts on demand, because cmdk auto-scrolls on mount.
  - **T1.2:** add `packages/crypto` to the workspaces.
  - **T3.x:** reuse `components/nanite/*` for the real screens.
  - **T4.3:** create the Vercel project, connect Neon, set env vars, and check the Hobby cron limits.
  - **Explorer path:** the Arkiv explorer entity path (`/entity/<key>`) is unverified; there's a TODO in `arkiv-entity-chip`.
- **Commits:** Phase 4 in `claude/commit-plan.md` (14 commits, after Phases 2 and 3).

### T3.6 (custom domain onboarding), 2026-11-06, Q1

- **Outcome:** Built and tested against fakes (fake Resend admin, fake DNS); the real Resend API was never called. Needs review plus a live check by the orchestrator.
- **Revision (Vikrant, same day): the domain is OPTIONAL.** Step 04 is a choice: "Use your own domain" (recommended, with the 72 h DNS note) or "Start now with the shared domain" (zero setup, shows the user's example address `<agent>.<user>@SHARED_MAIL_DOMAIN`, taken from `sharedMailDomain` in `/onboarding/status`). With an own domain the user can press "Continue for now" at any time; verification keeps running in the background. `POST /onboarding/complete` no longer needs a verified domain; `POST /agents` uses `<agent>@<domain>` only while the domain is verified, otherwise the shared address, never a 409. Existing agents keep their address when a domain verifies later (no migration of old agents). The dashboard has a "Mail domain" card (`components/dashboard/mail-domain-card.tsx`) that reuses `DomainStep` (`variant="settings"`, no choice screen) so a user who skipped can add a domain later and see a pending one. The `domain_not_verified` error no longer exists.
- **Flake fixes:** (1) `resend-integration` crash-recovery: the startup sweep compared `updated_at < now` against the JS clock, which misses rows written in the same millisecond or by a DB clock a hair ahead; at startup the sweep now has no age condition at all (a fresh process has nothing in flight). (2) e2e `watchProblems` ignores only `net::ERR_ABORTED` on a `?_rsc=` request (an aborted Next RSC prefetch).
- **What works:**
  - Wizard `01 connect, 02 keys, 03 username, 04 domain, 05 done`. Step 04 (own domain): enter the domain, check (provider, MX warning, subdomain suggestion), create in Resend, records table with copy buttons and a per-record chip (`waiting`, `found in DNS`, `verified`), provider tips, 5 s polling (15 s after 2 min, paused in a hidden tab), "last checked Ns ago", "Check now" (30 s cooldown), "Use a different domain", resume after reload, live region for status changes.
  - API: `POST /onboarding/domain/check`, `POST|GET|DELETE /onboarding/domain`, `POST /onboarding/domain/verify`; background verifier; Resend `domain.*` webhook events; `domain: {name, status}` in `/me` and `/onboarding/status`; agents on a verified user domain get `<agent>@<domain>` (mailbox and ENS `email`), all others the shared address.
  - Run: `docker compose run --rm tools npm run test -w apps/api` (needs db up; includes `test/domains.test.ts`), `docker compose --profile e2e run --rm e2e npx playwright test tests/domain.spec.ts`.
- **Migration:** `packages/db/migrations/0003_amazing_radioactive_man.sql`, only `user_domains`. Apply to `nanite_live` yourself (`DATABASE_URL=.../nanite_live`); it is already applied to the dev `nanite` database.
- **To do before this works for real:** (1) `RESEND_API_KEY` Full access in the API env (already needed); (2) subscribe the webhook to the domain events: `docker compose run --rm tools npx tsx apps/api/scripts/resend-webhook-domain-events.ts` (lists webhooks), then `--id=<id> --apply`; (3) Resend free plan has 3 domains, 1 used, so a real user flow needs a free slot or a paid plan (`409 domain_limit_reached` otherwise); (4) give `nanitedemo` the platform domain with `apps/api/scripts/assign-domain.ts --user=nanitedemo --domain=nanitecom.itsvikrant.tech` (local DB only; verified only if Resend reports it verified).
- **Deviations / notes:**
  - No new onboarding enum value: the `domain` step is derived from `user_domains` (state stays `name_claimed` until `complete`), so the migration adds only the table.
  - Mailboxes of user domains point at a `domains` row (owner = the user) created when the first agent is added.
  - `GET /onboarding/domain` answers 404 `no_domain` before a domain exists (the wizard only calls it when `/me` has a domain).
  - Rate-limited verify answers `429 verify_rate_limited` with `retryAfterSeconds` and a `Retry-After` header.
  - The public-suffix list is a small hard-coded set of two-level suffixes (co.uk, co.in, com.au and others), not the full list.
  - `FAKE_RESEND_DOMAINS=1` (non-production) wires an in-memory Resend and DNS for dev; it never verifies by itself.
  - `apps/api/test/outbound.test.ts` (signature v3 headers) was already failing when I ran the suite; it is outside this task.
