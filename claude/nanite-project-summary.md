# Nanite: Project Summary (ETHGlobal Mumbai 2026)

Nov 5, 2026 · Vikrant

**Read first:** `claude/nanite-status-and-decisions.md` (current state, confirmed facts, rules) and `claude/nanite-task-plan.md` (all tasks, one per new Claude Code conversation). This summary is the design reference; where it disagrees with the status file, the status file wins. Source of truth with the two SVG diagrams: https://claude.ai/artifact/1buBw3jnpVVPqVCnUpKSxx

## Project and problem

Nanite gives each AI agent its own email address, with mail stored encrypted on Arkiv and agent identity on ENSv2. The idea: agents should get delegated access to your resources, never own them.

- **Product:** a user connects a wallet, claims `username.nanitecom.eth`, and adds agents. Each agent gets `alex.username.nanitecom.eth`, an address like `alex@domain`, and a wallet.
- **Why Arkiv:** the user owns the record of their conversations (clients, disputes) instead of depending on Gmail. Arkiv entities have an owner wallet, SQL-like queries and a chosen expiry, so OTPs can vanish after minutes while client mail is kept for years.
- **Why ENS:** 20+ agents become unmanageable by address. An ENS subname per agent maps name to wallet and email, and ENSv2 roles let an agent edit only its own records.
- **Differentiation:** services like AgentMail already offer agent email. Nanite leads with ownership, verifiable identity and delegated permissions.
- **MVP rule from the team:** it does not need to be perfect or glued together; it needs to shine on the prize criteria.

## Prize targets

The plan is Build on Arkiv ($4,000 pool) plus ENSv2 ($7,000 pool), with the Swarm bonus ($500) as a stretch. Arkiv counts as one partner pick, so there is room. Both tracks require from-scratch work done at the event, so no app code before the start.

| Prize | Prize money | What it needs | Status |
| --- | --- | --- | --- |
| Build on Arkiv | $3,000 / $1,000 | Writes to Arkiv testnet with `@arkiv-network/sdk`; at least one user-facing feature reads from it; repo with open-source license | Primary target |
| Best Use of ENSv2 | $3,000 / $2,000 / $1,000 / $1,000 | ENSv2 central to the product on mainnet or Sepolia; functional demo (no hard-coded values); live demo link; open-source repo | Primary target |
| Arkiv + Swarm bonus | $500 | Meaningful Swarm use alongside Arkiv; `/arkiv/swarm.md` | Stretch (attachments) |

**Arkiv judging (25% each):** feedback (`friction.md`), reach (`reach.md`), why Arkiv (`why-arkiv.md`), how you use Arkiv (`how-you-use-arkiv.md`).

**Required in the repo:**

- `/arkiv/schema.md`: entities, queried fields, owners, expiries
- One file per judged criterion, answered with links, numbers or a runnable query
- README with the writer wallet addresses and one query judges can run
- Public repo, open-source license, and a note on how AI was used
- Keep a running list of friction as it happens; it is 25% of the Arkiv score

## Architecture

(Diagram in the Claude Doc.) Sender → Resend → Nanite ingest → Arkiv. Ingest ↔ Postgres. Dashboard and Agent API read Arkiv. ENSv2 names feed the Dashboard and Agent API.

Mail arrives through Resend, is encrypted by Nanite ingest and written to Arkiv. The dashboard and the agent API each read Arkiv and decrypt their own copy; ENS supplies identity and permissions; Postgres holds only routing and wrapped keys.

## Email module

Decision: use Resend for inbound mail now, behind a provider interface so it can be swapped later.

- **How it works:** add a domain via `resend.domains.create({ name, capability: 'send-and-receive' })`, add the DNS records (including the receiving MX), and Resend then accepts mail for any address at that domain. It sends an `email.received` webhook; the full body comes from the Receiving API.
- **Creating mailboxes needs no Resend call.** `alex@...` is just a row in Nanite's routing table. Unknown recipients are dropped.
- **Free tier (checked on the pricing page):** 3 domains, 3,000 emails a month, 100 a day, 1 webhook endpoint, 30-day retention. Received mail counts toward the quota. Pro is $20 a month for 10 domains.
- **Subdomains:** each added subdomain is its own domain entry, so assume it uses a slot. The Usage API (`resend usage`) shows `domains used / limit` and can confirm this in minutes.
- **Do not create a subdomain per user or agent.** Use one shared domain for the demo and keep the other slots for a bring-your-own-domain demo.
- **MX conflicts:** if a domain already has Gmail or Workspace MX records, use a subdomain so existing mail is not broken.
- **Per-domain limits at scale** push toward the provider interface (`receive()`, `verifyDomain()`, `send()`) with tenant routing in Nanite's own database.

**Alternatives discussed (not chosen for now):**

| Option | Good | Bad |
| --- | --- | --- |
| Cloudflare Email Routing + Worker | Raw `.eml` with DKIM headers, no daily cap, no servers | Domain must use Cloudflare DNS; Worker CPU limits; one report says no subdomain catch-all |
| Own SMTP on an EC2 `t4g.micro` | No third party sees plaintext; unlimited domains | Needs inbound port 25 open, TLS, spam handling; risky for a live demo |

The raw signed email is what would make the "proof it happened" claim real, since DKIM can be verified later. Resend only gives parsed content. Revisit after the hackathon.

## Encryption design

The agreed claim is "end-to-end from the moment we receive it," not from the sender. Resend hands Nanite plaintext, so the server encrypts immediately, keeps plaintext in memory only, and writes nothing readable to disk or Arkiv.

**Envelope encryption per email:**

1. Generate a random 256-bit content key.
2. Encrypt subject, body and raw `.eml` with an AEAD cipher (AES-256-GCM or XChaCha20-Poly1305).
3. Seal the content key to each reader's public key (libsodium sealed box or HPKE): once for the user, once for the agent.
4. Write one Arkiv entity with the ciphertext, the wrapped keys and a `keyId`.
5. Zero plaintext and the content key from memory.

**What this borrows from WhatsApp:** private keys stay with their owner, the server holds only public keys, a random key per message is wrapped per recipient. It cannot borrow X3DH or the Double Ratchet, because the sender is an ordinary mail server, so there is no forward secrecy yet.

**Plaintext fields on Arkiv (needed for queries):** agent id, owner id, received time, email type (otp or conversation), thread id, and an HMAC of the sender address (a blind index). Subject and body stay encrypted. Volume and timing are visible, and the docs should say so.

**Main risks to state honestly:**

- The server sees plaintext at ingestion.
- Public ciphertext stays readable forever if a user's key later leaks; expiry limits the damage.
- Revoking an agent stops future wraps but cannot undo what it already read.
- Emails are untrusted input for agents, so the API labels bodies as untrusted and extracts OTPs and links into structured fields.

**Hygiene:** verify webhook signatures, drop unknown recipients before any processing, never log content, and store the raw `.eml` encrypted so DKIM can be checked later.

## Keys and recovery

The user's private key never leaves the browser, and losing access to it means losing the mail unless a recovery path exists. The biggest risk named by the team is losing the wallet.

**User key flow (one-time setup):**

1. The browser generates an X25519 keypair.
2. The wallet signs a dedicated key-derivation message (never the login message); HKDF turns the signature into a wrapping key.
3. The private key is encrypted under that wrapping key; only the public key and the wrapped blob go to the server.
4. Each session, the user signs the same message again to unlock the key in memory only, never `localStorage`.
5. Sign twice at setup and compare; if the signatures differ (some smart-contract or MPC wallets), fall back to a passphrase.

**Recovery code:** a random high-entropy code, shown once, derives a second wrapping key and a second wrapped blob. It works like a Proton recovery phrase, not like a GitHub backup code: nobody can verify it or reset anything, because the server holds nothing that decrypts mail. Lose both wallet and code and the mail is gone. Recovering the wallet from its seed phrase restores the same signature, so the real risk is losing that seed.

**Agent wallets from one seed:** the browser generates a random "nanite seed", wrapped the same two ways (wallet signature and recovery code). Each agent is derived by index (BIP-32/44, for example `m/44'/60'/0'/0/<index>`), and its encryption keypair is derived under a different label. "Add agent" is one click with no extra wallet prompt. MetaMask and Phantom cannot be told to add accounts, so this is Nanite doing the same thing itself. The seed is never sent to the server; only a per-agent child key is, when custody requires it.

**Top risks for the MVP:** wallet loss (mitigated by the recovery code), non-deterministic wallets (passphrase fallback), and server plaintext at ingestion (stated honestly). Key rotation, forward secrecy and KMS for the master key are roadmap items.

## Agent access

Users read their mail by decrypting in the browser. Agents read through an API, so their copy is decrypted by whoever holds the agent's private key. Each email carries a separate wrapped key per reader.

| | Hosted API | Self-hosted container | Direct SDK |
| --- | --- | --- | --- |
| Who runs it | Nanite | The user (`docker run`) | The agent process |
| Agent private key held by | Nanite, under the master key | The user's container | The agent |
| Can Nanite read agent mail | Yes | No | No |
| Agent integration | HTTP or MCP with token | Same API, local base URL | Library calls |
| Role in the plan | Default for the demo | Advanced; roadmap or short demo | Optional judge moment |

- **Per-agent flag:** `custody = nanite | self`. With `self`, the server stores only the agent's public key and wraps mail to it.
- **API sketch:** `GET /v1/inbox`, `GET /v1/emails/{id}`, `GET /v1/otp/latest`, `GET /v1/emails/wait` (long-poll for signup flows), plus a small MCP wrapper.
- **Auth:** per-agent token (shown once, stored hashed) for the MVP; a wallet-signed nonce to a short-lived JWT is better.
- **Rules:** a token sees only its own agent's mail, read-only, rate limited, access logged without bodies, content labelled untrusted.
- **Self-hosted container:** reads Arkiv directly, so it keeps working if Nanite shuts down. Key provisioning for the MVP is a per-agent key file exported from the dashboard and mounted into the container. The user's own copy stays decrypted only in the browser in every option.
- **Demo moment:** stop the Nanite server and show an agent still reading its mail through the container or SDK.

## Outbound email, permitted by ENS (added Nov 5, 2026)

Agents can send email to anyone, but only within a policy that the user sets in the agent's ENS records. Nanite enforces it on every send. The policy is public and verifiable, and the agent cannot change it.

- **Policy records** on each agent's own resolver, set at creation, settable only by the user (and the operator); the agent wallet has no setter role for them:
  - `nanite.send`: `off` | `reply-only` (default: only to people who wrote first) | `allowlist` | `any`
  - `nanite.send-allow`: allowed recipients (addresses, `@domain`, or ENS names)
  - `nanite.send-limit`: maximum sends per day
- **Flow:**
  1. The agent calls `POST /v1/emails/send`.
  2. Nanite resolves the policy records fresh through the Universal Resolver (never cached for long) and returns 403 if the send isn't allowed.
  3. It sends through Resend from `agent@domain`, with threading headers and `X-Nanite-Agent: <ens name>` plus a signature by the agent's wallet, so recipients can verify the sender via ENS.
  4. It stores an encrypted sent copy on Arkiv (`type = "sent"`, owned by the user) and logs the send without the body.
- **Revoke or restrict:** the user changes one ENS record (dashboard toggle), and the next send obeys it. A full revoke also removes the agent's API access.
- **Why it matters:** incoming email is untrusted, and prompt injection could make an agent send data to an outsider. The default `reply-only` policy and daily caps limit that. Deliverability on a new domain and Resend's free tier (100 emails a day, received and sent combined) are the practical limits.
- **Demo moment:** set `nanite.send = off` in the dashboard and show the agent's send failing, then allowlist one address and show it succeed, with the policy visible to anyone who resolves the agent's name.

## Data split

Postgres holds only operational state and wrapped secrets; email content and the public agent record live on Arkiv. The database is meant to be rebuildable from Arkiv, ENS and the recovery code, which supports the "why Arkiv" answer.

| Table | Holds |
| --- | --- |
| `users` | wallet, username, ENS name, onboarding state (for resumable sign-up) |
| `user_keys` | public key, wallet-wrapped and recovery-wrapped private key and seed, salts, key version |
| `domains` | owner, name, Resend domain id, verification status, DNS records |
| `mailboxes` | the routing table: address to user and agent, status (hit on every inbound email) |
| `agents` | owner, name, derivation index, wallet, ENS name, public key, custody, revoked state; private key only if custody is `nanite`, encrypted under the master key |
| `api_tokens` | agent id, token hash, last used, expiry, revoked |
| `webhook_events` | Resend email id (unique), status, Arkiv entity key, error (dedupe and replay) |
| sessions / nonces | SIWE nonces and sessions (or signed JWT cookies) |
| `audit_log` (optional) | agent, endpoint, time; never bodies |

**Never in Postgres:** email bodies, subjects or raw mail; plaintext private keys, the seed, signatures or the recovery code; the master key and the sender-hash secret (env or KMS).

**Open question: who writes Arkiv entities?** A Nanite operator wallet is simplest but weakens "you own your data." The user's wallet or a user-derived writer key gives real ownership but needs a signature or delegated key per write. A derived per-user "mailbox writer" key is the proposed middle path. Check Arkiv's delegation support and entity payload size limit, and log findings in `friction.md`. (Task T0.3.)

## ENSv2 design

The plan is to build and demo on Sepolia, keeping `nanitecom.eth` on mainnet as the production name. Mainnet and Sepolia are separate ENS deployments, so a Sepolia name was registered on its own.

**Status of the name:** `nanitecom.eth` is registered on Sepolia as an ENSv2 name (done Nov 5, 2026). Owner `0x8fFD876f6200BCF671714E35b860aDFD57a6a542`, expires Nov 5, 2027. This is the same wallet that owns the mainnet name, so its private key must never go into scripts or `.env` files; owner steps are signed in the browser wallet, and server scripts use a separate operator wallet. Contract addresses and confirmed interfaces are in the status file.

**Sepolia facts from the docs:**

- Registration is paid in `MockUSDC` (open `mint`) plus Sepolia ETH for gas.
- The Universal Resolver sits at the same address on mainnet and Sepolia. Reads work through viem `getEnsText` and `getEnsAddress`; writes use DNS-encoded names, and ENSjs 5.2.5 or later has v2 write helpers.
- Always look up a name's resolver fresh before writing; never hardcode it.

**Design:**

- `nanitecom.eth` points to a UserRegistry. An operator wallet holds only `ROLE_REGISTRAR` and `ROLE_RENEW` on it, so a leaked server key cannot take the parent name.
- Each user's name `vikrant.nanitecom.eth` has its own registry, owned by the user wallet.
- Each agent name `alex.vikrant.nanitecom.eth` gets its **own Permissioned Resolver proxy**. Resolver roles are scoped by record key (or coin type) but not by name, so a shared resolver would let an agent edit its siblings' records.
- The agent's wallet gets only key-scoped setter roles. The agent name token stays with the user, without resolver-change or transfer roles, so the agent cannot repoint or sell itself.
- Records per agent: `addr`, `email`, `nanite.pubkey`, and ENSIP-26 `agent-context` and `agent-endpoint[mcp]`. ENSIP-25 `agent-registration[...]` is an optional stretch.
- Expiry per agent gives temporary agents for free, since names stop resolving at expiry.
- Starting managed (operator keeps roles) lets users later revoke the operator's roles to eject Nanite, matching the prize's "no parent control" language. Emancipation is irreversible.

**Call sequence (confirm in task T0.4):**

1. Owner: deploy a UserRegistry for `nanitecom.eth` via the Verifiable Factory (`deployProxy(implementation, salt, initialize(grants))`), granting the owner `ALL_ROLES` so it can delegate later.
2. Owner: `setSubregistry` on the `.eth` registry to point at it (needs `ROLE_SET_SUBREGISTRY` on the name; unverified).
3. Owner: `grantRootRoles(ROLE_REGISTRAR | ROLE_RENEW, operator)` on the new registry.
4. Per user: operator deploys the user's registry, registers `username` in the nanitecom registry owned by the user wallet, and the user gets root roles.
5. Per agent: operator deploys a resolver proxy (`initialize(grants, calls)` with initial records), grants the agent key-scoped setter roles via `grantSetterRoles`, then registers `agentname` in the user's registry with that resolver.
6. Revoke: remove the agent's setter roles; optionally unregister the name so it stops resolving.

**Resolved from the docs (Nov 5):** resolver `initialize` is `initialize(Grant[] grants, bytes[] calls)`; any `uint256` salt is allowed and is scoped to the deployer (`msg.sender`), so one resolver per agent is fine; `ALL_ROLES` includes the admin roles needed for later grants.

**Still open (task T0.4):**

- Whether the owner wallet holds `ROLE_SET_SUBREGISTRY` on `nanitecom.eth` in the `.eth` registry.
- Whether the operator wallet can call `register()` directly (role-gated, so likely yes) without a registrar contract.
- Exact types of `Grant` and function signatures: confirm in the Sepolia Explorer (the `contracts-v2` GitHub repo could not be fetched from the research environment).
- Fallback: subnames as plain resolver records (no tokens or registries) are cheaper but give agents no per-name permissions.

## Onboarding and add-agent flows

(Diagrams in the Claude Doc: 5 steps each.)

Both flows create keys first, so no ENS name or mailbox exists without a way to read its mail. Each step is resumable: onboarding state is stored per user, and deterministic proxy addresses let a retry skip work already done. Signatures, the seed and the recovery code are never stored on the server.

## Hackathon plan

The scope is the narrowest version that makes Arkiv and ENSv2 visibly central: one shared domain, inbound mail only, three screens (sign-up, agents list, one agent's inbox) and one agent API call. Everything else is faked or cut. The full task list, with time boxes, deliverables and done-when criteria, is in `claude/nanite-task-plan.md`.

**Build priority (cut from the bottom):**

1. Inbound pipeline: Resend webhook, address check, encrypt, Arkiv write with expiry.
2. Inbox reads from Arkiv with filters (agent, type, time); this is what qualifies for the Arkiv track.
3. ENSv2 subnames for users and agents, with the email stored as a text record.
4. Enhanced Access Control: the agent edits only its own records and the user can revoke it.
5. OTP expiry demo: an OTP email that disappears from queries.
6. Swarm for attachments, only if time remains.

**Demo script:**

1. Sign up and see `vikrant.nanitecom.eth`.
2. Add agent "alex" and see its ENS name and `alex@` address.
3. Send a real email from a phone; it appears in the inbox, and the Arkiv explorer shows the encrypted entity.
4. An agent fetches it through the API; revoke the agent and show access fail.
5. Send an OTP and watch it expire.
6. The agent replies by email; the user turns sending off in ENS and the next send is refused.

Record a backup video, since live email and testnets can fail.

**Housekeeping:** keep keys in `.env` files out of git, set a renewal reminder for the one-year free mainnet claim and the Sepolia name (both expire Nov 2027), and write the `/arkiv/*.md` files while building.
