# Nanite live demo script

Two timed versions (4 minutes for judges, 2 minutes short), a prep checklist, a fallback plan and the two prize stories in neutral wording. Screens and labels match `docs/user-guide.md` (section numbers in brackets); screenshots to use as fallback are in `docs/guide-shots/`.

## Facts that shape the demo

- The deployed API (production flags) cannot be seeded: `seed-demo.ts` needs `FAKE_RESEND_CONTENT=1`, which production ignores. On the deployed stack the demo account must be created through the real onboarding beforehand and mail must be real (Gmail to the agent).
- The seeded demo data (`nanitedemo`, agents `alex` and `scout`, five invented mails) lives in the `nanite_live` database. It works only against a local or tunnelled API, signing in with the test-user wallet (imported into MetaMask from the local `.env`; never the owner wallet of `nanitecom.eth`).
- Conversation mail lives 2 days by default and OTPs 5 minutes, so mail must be fresh on the day.
- Agents on `nanitedemo` created earlier carry the placeholder domain `@nanite.test` in their ENS `email` record (`alex`); `mail.nanitedemo` and `kit.nanitedemo` use `nanitecom.itsvikrant.tech`. For the deployed demo create a fresh agent so its ENS records show the real domain and `agent-endpoint[mcp]` = the deployed API.
- The first inbox read can take several seconds (public Rabdi endpoint, no access key); set `ARKIV_ACCESS_KEY` on the server.

## Prep checklist (day before and 30 minutes before)

1. Deployed stack up: `curl -s $API/health` returns `{"ok":true,"db":"up",...}`; web loads; operator balances fine (ENS operator above 0.05 ETH, Arkiv operator has tGLM).
2. Demo account onboarded on the deployed site with MetaMask on Sepolia (recovery code stored), agent `alex` created, send policy set to Allowlist with your Gmail address and a daily limit, token stored in a secret manager.
3. Local fallback ready (optional but recommended): `docker compose up -d db`, start the live API as in `apps/api/LIVE-E2E.md` ("Databases"), then `docker compose run --rm -e API_URL=http://nanite-api-live:4000 tools npx tsx apps/api/scripts/seed-demo.ts` right before the demo (idempotent; it resends only missing mail, including fresh OTPs).
4. Browser: MetaMask unlocked, one tab on `$WEB/dashboard` **locked** (fresh load, so you show the unlock), tabs for: Arkiv explorer, Gmail (inbox plus the sent folder), a terminal with `$API` and `$TOKEN` exported, the ENS resolve snippet (guide 9.2) ready to run, and Etherscan (Sepolia) for one recorded transaction.
5. Just before going on: send one mail from Gmail to the agent with a body like "Your verification code is 482913" (it is stored as a one-time code and lives 5 minutes, so send it about 1 minute before the OTP step), and one normal mail with a link.
6. Rehearse the send: from the agent to your Gmail (policy Allowlist) and check the reply arrives signed (headers `X-Nanite-*`).
7. Record a screen capture of the whole run and keep the screenshots from `docs/guide-shots/` in a folder.

## Fallback if the network is slow or something fails

- Arkiv or Sepolia slow: say so, switch to the pre-recorded clip for that step, then continue live. The inbox retries on its own ("Arkiv did not answer... retrying automatically").
- Wallet or site down: play the full recording; narrate over it.
- No time to wait for DNS or ENS writes: never do them live; show the screenshots (`10-dns-waiting`, `12-domain-verified`, `31-send-policy-allowlist`) and a past Sepolia transaction.
- Email delayed: use the seeded local data (item 3) or the screenshot `54-otp`.

## 4-minute version (judges)

| Time | Click / do | Say (one line) | Show |
| --- | --- | --- | --- |
| 0:00 | Home page, press **Get started** [1.1] | "Every AI agent gets its own email address; you own the mail, not us." | Home, onboarding header `01 connect ... 05 done` |
| 0:20 | Skip ahead: show the recorded or screenshot of the recovery code [1.5] | "Keys are made in your browser; the recovery code is the only backup, and we cannot read your mail." | `05-recovery-code` |
| 0:35 | Open the locked dashboard, press **Unlock it**, **Sign to unlock** [2.1] | "One wallet signature, no gas; the key lives in this tab's memory only." | Locked state, then agent tile with ENS name `alex.<user>.nanitecom.eth` |
| 0:55 | Run the ENS resolve snippet for the agent [9.2] | "The agent is an ENS subname with its own resolver; address, email, send policy and signer are public records." | `addr`, `email`, `nanite.send`, `nanite.signer`, `agent-endpoint[mcp]` |
| 1:25 | In Gmail send the prepared mail to the agent; in the app press **Open inbox**, **All mail** [5.1] | "A real email arrives, is encrypted by the API and written to Arkiv, and decrypts here in the browser." | Message appears with subject and body; links listed as text [5.3] |
| 1:55 | Click the Arkiv chip at the bottom of the message [5.6] | "This is what Arkiv holds: ciphertext, owned by my wallet, created by the operator." | Explorer entity page: owner = your wallet, creator = operator, no readable content |
| 2:15 | **One-time codes** tab [5.4] | "OTPs get a countdown and vanish from Arkiv at their expiry block." | Large code, "expires in M:SS", badge `valid` |
| 2:35 | Back in **All mail**, press **Keep**, pick **30 days** [5.5] | "Normal mail expires in 2 days unless kept; extending is an Arkiv feature and we pay the fee." | "Kept for 30 more days." |
| 2:55 | **Settings**: show **Sending policy** (Allowlist) and the **Mail signing** card [6.1, 6.3] | "Who the agent may email is an ENS record the agent cannot write; every send is checked against ENS." | `ens://send-policy` console, `published` signer badge |
| 3:15 | Terminal: `curl .../v1/otp/latest` and the Claude Code MCP list-inbox [7.4, 8.1] | "The agent reads its mail with a token over REST or MCP; email content is marked untrusted." | JSON with `content_trust: "untrusted"` |
| 3:35 | Agent replies to Gmail; in Gmail open **Show original**; run the verify script [9.1] | "Anyone can verify the sender: the signature must recover to the signer address on the agent's ENS name." | `{"valid":true,...,"reason":"ok"}` |
| 3:50 | Close | "User-owned encrypted mail on Arkiv, identity and permissions on ENSv2." | Dashboard |

## 2-minute version

| Time | Click / do | Say | Show |
| --- | --- | --- | --- |
| 0:00 | Unlocked dashboard, agent tile | "An agent with its own address and ENS name; I own the mail." | Tile |
| 0:15 | Resolve the agent on ENS [9.2] | "Identity, policy and signer are ENS records." | Records output |
| 0:35 | Send the prepared Gmail; **Open inbox** | "Real email, decrypted only in my browser." | Message, links as text |
| 1:00 | Arkiv chip | "Arkiv holds ciphertext owned by my wallet." | Explorer |
| 1:15 | **One-time codes** | "OTPs expire on-chain at their block." | Countdown |
| 1:30 | **Settings**, Allowlist and signer | "The agent cannot change its own permissions." | Settings page |
| 1:45 | Verify a signed reply [9.1] | "Mail verifies against ENS." | `valid: true` |

## What to show where

- **Arkiv explorer**: `https://rabdi.explorer.arkiv.network/entity/<key>` (the chip in each message). Or the runnable query: `docker run --rm -v "$PWD/arkiv:/w:ro" alpine:3.20 sh -c 'apk add -q curl jq && LIMIT=0x5 sh /w/query.curl.sh'` [9.3].
- **ENS**: the resolve snippet in the guide (9.2) is the reliable view; app.ens.domains may not display ENSv2 names on Sepolia (not checked). Negative proof of the key-scoped role: `docker compose run --rm tools npx tsx scripts/ens/verify.ts` (read-only simulations on the test name `t04test.nanitecom.eth`: agent 0's `setText(agent-context)` simulates fine, while `setText(email)` and `setAddress(60)` revert with `EACUnauthorizedAccountRoles`, and agent 1 cannot write agent 0's record). Revoke removes even that one role (LIVE-E2E.md step i).

## Prize story: Arkiv

- Mail is stored as Arkiv entities, ciphertext only: subject, body and sender address are not public; per-email content key sealed to the user and the agent.
- User-owned: the operator creates each entity and `changeOwnership` to the user's wallet in the same `executeBatch`; `$creator` = operator, `$owner` = user, and afterwards the operator cannot patch, delete or take it back. Users hold no tGLM and sign nothing for mail.
- Creator-pinned queries: anyone can write look-alike entities with our schema, so every query pins `$creator` to the operator and readers re-check it; the judge-runnable query is `arkiv/query.curl.sh`.
- Expiry: OTPs expire at an exact block (verified live: gone at the `expiresAt` block); other mail lives 2 days by default, up to Arkiv's ~182.5-day maximum.
- Extension: conversation and sent entities are created with `permissionlessExtension`, so Keep (user) and `extend_email` (agent) can extend them with the operator paying; OTP entities never get it. Extension counts from now and never shortens.
- Friction notes: `arkiv/friction.md`.

## Prize story: ENSv2

- Every agent is a subname: `<agent>.<user>.nanitecom.eth`; each user has their own registry (UserRegistry via the VerifiableFactory) under `nanitecom.eth`.
- Each agent has its own PermissionedResolver, because ENSv2 resolver roles are scoped per key, not per name.
- Key-scoped roles: the agent wallet may write only `agent-context`; it cannot change `email`, `addr`, `nanite.pubkey` or any `nanite.*` record (proved by simulation above). The user owns the agent name; the operator holds only the roles it needs.
- Policy as records: `nanite.send`, `nanite.send-allow`, `nanite.send-limit` (send policy), `nanite.otp-ttl`, `nanite.mail-ttl`, `nanite.extend`, `nanite.extend-limit` (retention) and `nanite.signer` (mail-signing key) are read fresh from ENS on every send and fail closed.
- Revoke: the agent's token and mailbox are disabled and its `agent-context` setter role is revoked on ENS.
- Verification from ENS: outgoing mail carries `X-Nanite-*` headers; a verifier resolves the agent name, reads `nanite.signer` and checks the signature recovers to it.

---

## Validation

Legend as in the user guide: **a** Playwright with mocked wallet and fake API; **b** real calls or runs; **c** code reading.

| step | method | result |
| --- | --- | --- |
| Prep 1 health check | b: `/health` on the throwaway API returned `{"ok":true,"db":"up"}`; deployed URL not up | local validated; deployed not validated |
| Prep 2 onboarding and agent creation | a (guide steps 1.x, 4.x) | UI validated with mocks; real onboarding on the deployed site not validated |
| Prep 3 seed-demo | c (script and LIVE-E2E.md); not re-run (it writes to Sepolia and Arkiv) | not validated here; recorded live run in LIVE-E2E.md |
| Prep 5 OTP mail | c (LIVE-E2E.md: a real Gmail mail with a code was stored as `otp`) | not validated (no real email) |
| 0:00 to 0:20 home, Get started | a | validated |
| Recovery code screenshot | a | validated |
| Unlock, agent tile | a (fixture ciphertext, `?next=` return) | validated |
| ENS resolve | b: ran against Sepolia for `alex.nanitedemo.nanitecom.eth` (address, `nanite.send`, signer, endpoint) | validated |
| Gmail to agent, inbox decrypts | a (decrypt with real ciphertext); real Gmail not run | UI validated; real email not validated |
| Arkiv chip, explorer | a (chip, link, "owned by your wallet"); b (`query.curl.sh` returned owner and creator addresses, no content) | validated; the explorer page itself not opened |
| OTP tab, countdown | a | validated |
| Keep 30 days | a; b: `extend.test.ts` (16 passed) | validated |
| Settings, send policy, mail signing | a | UI validated; real ENS write not run |
| curl otp/latest, MCP list inbox | b: `/v1/otp/latest` 404 (no mail), `/mcp` initialize and tools/list, stdio `list_inbox` | validated; `claude mcp add` not executed |
| Reply plus Gmail Show original plus verify | b: verify script runs, exit codes 1 and 2 checked; c for the rest | partly validated; a valid verdict is recorded in LIVE-E2E.md |
| `scripts/ens/verify.ts` role proof | b: ran read-only; `setText(email)` and `setAddress(60)` revert with `EACUnauthorizedAccountRoles`, agent 1 cannot write agent 0's record | validated |
| Timings (4 min and 2 min) | c: estimates, not rehearsed | not validated |
| Fallback plan | c | not validated |

Summary: 11 rows validated, 5 partly, 5 not validated (deployed URLs, real email, seeding, timings, fallback).
