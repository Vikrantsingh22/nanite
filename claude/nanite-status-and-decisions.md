# Nanite: Status and Decisions

Last updated: Nov 5, 2026. Owner: Vikrant. Read this first in every new conversation, then the task plan (`claude/nanite-task-plan.md`) and the project summary (`claude/nanite-project-summary.md`). Where this file and the summary disagree, this file wins.

## How we work (process rules)

- The project is built in phases, and every task runs in its own new conversation with Claude Code. The full task list is in `claude/nanite-task-plan.md`.
- One task per conversation. Do only that task, stay inside its time box, and do not start the next task.
- At the end of each task: update the status table in the task plan, write handoff notes (done, not done, deviations, next step), and append anything that hurt to `arkiv/friction.md` in the repo (it is 25% of the Arkiv score).
- If a task reaches its time box without being done, stop, write down what is left, and decide what to cut. Do not borrow time from the next task.
- MVP rule: it must shine on the prize criteria, not be perfect. Cut from the bottom of the priority list.
- Roles: the main Claude Code session never writes code. It orchestrates, validates, reviews and reports to Vikrant. All code and task work is done by Sonnet subagents it spawns; fixes found in review go back to a subagent.
- Docker for everything: every service, database, script and dev command runs in Docker (Docker Compose for local dev).
- Git: no commits until Vikrant explicitly says to start committing. Never add Claude as co-author (no `Co-Authored-By` trailer, no "Generated with Claude Code" line) in commits or PRs.

## Security rules for all tasks

- Never commit keys, `.env` files, the Resend key, the master key or the sender-hash secret.
- The wallet `0x8fFD876f6200BCF671714E35b860aDFD57a6a542` also owns the mainnet `nanitecom.eth`. Its private key must never go into a script, `.env` file or chat. Owner steps are signed in the browser wallet. Server scripts use only the operator wallet and test wallets.
- Email content is untrusted input. Never log bodies. Postgres never holds bodies, plaintext private keys, the seed, signatures or the recovery code.

## Confirmed facts

**ENS name on Sepolia (done):**

- `nanitecom.eth` is registered on Sepolia and is an ENSv2 name (checked in the ENS app by connecting the wallet).
- Owner: `0x8fFD876f6200BCF671714E35b860aDFD57a6a542` (a regular wallet, not a smart account that we know of). Registered Nov 5, 2026; expires Nov 5, 2027.
- The mainnet `nanitecom.eth` is the same name on a separate deployment, claimed free for one year via Devcon. Do not touch it.
- The Sepolia ENS app asked for a "smart session" signature and showed a smart account address `0x13BA…7C15` in it. We do not know what that address is; it is not the owner of the name. Do not sign smart-session prompts unless needed.
- Wallets we hold: owner (above), 100 Sepolia ETH, 100 MockUSDC minted (some spent on registration).
- Test wallets (created in T0.1, addresses in `docs/wallets.md`, keys only in local `.env`): operator `0x38CbFe210ce51A97fE698982952412AB12ad3dab`, test user `0xfAD31e74F1Cb69046BBB2e4A15ce653beE6936C0`, agents derived from the test seed at `m/44'/60'/0'/0/<i>`: agent 0 `0xC0575045B1acacC1349e3e5f8bE20FBA3a8E287b`, agent 1 `0xd817c0CbE139Bd900Fcfe7C016Df15D4d11EFab8`.

**ENSv2 setup on Sepolia (done in T0.4; all hashes in `docs/logbook.md` and `config/sepolia-deployments.json`):**

- `nanitecom.eth` UserRegistry proxy: `0xD2BE04253E815972D6a1D995670eBAc7a6C8C786` (salt `keccak256("nanitecom.eth/user-registry/v1")`, deployed by the owner, owner holds ALL_ROLES on root). `ETHRegistry.setSubregistry` and `setParent(ETHRegistry, "nanitecom")` are done.
- The operator holds only root `ROLE_REGISTRAR | ROLE_RENEW` (`0x10001`) on it.
- Test name `t04test.nanitecom.eth` (owner: test user, role set D3, expires 2026-12-05) uses its own PermissionedResolver proxy `0xd8Bab6066f02Edc516538d91c44Efae7e4145744` (salt `keccak256("nanite:t04test:agent0")`, deployed by the operator). Agent 0 can write only `agent-context`; writes to other keys revert.
- ABIs: `contracts/abi/` from `ensdomains/contracts-v2` at commit `07e55a05`; role values in `config/roles.json`.

**ENSv2 behaviour confirmed in T0.4 (supersedes the interface notes below where they differ):**

- `setText(bytes dnsName, string key, string value)` and `setAddress(bytes dnsName, uint256 coinType, bytes addr)` (not `setAddr`). Records are keyed by name (namehash of the DNS-encoded name).
- `grantSetterRoles(bytes setterCalldata, address account)`: pass a full encoded `setText(...)`; only the key (or coin type) is used. The scope is per key, not per name, so one resolver per agent (or per trust domain) is required.
- `UserRegistry.setParent(address parent, string label)` needs `ROLE_SET_PARENT`.
- `register()` from an account with root `ROLE_REGISTRAR` works directly, with no registrar contract. It grants the new owner any role bits (even ALL_ROLES and admin roles) without checking the caller's own roles, so operator code must build role bitmaps from a fixed allowlist.
- No parent-expiry check: a child expiry can exceed the parent's. Operator code must clamp to `min(requested, parentExpiry)` and reject expiry <= now (the contract reverts `CannotSetPastExpiry` at `now`). When the parent expires, all subnames stop resolving.
- `ROLE_CAN_TRANSFER_ADMIN` gates token transfer by the sender; on transfer all of the sender's roles on the token move to the recipient. Any role grant or revoke on a token bumps its tokenId version (low 32 bits), so do not cache tokenIds; use the labelhash as `anyId`.
- `PermissionedResolver.initialize(grants, calls)`: grants are applied first, and the `calls` skip role checks during initialization.
- Names resolve through UniversalResolverV2 automatically via the subregistry chain (root, ETHRegistry, nanitecom registry). viem `getEnsText` and `getEnsAddress` work with `universalResolverAddress` set.
- The public RPC (publicnode) can return stale reads right after a receipt; don't trust a read immediately after a transaction.

**Sepolia ENSv2 contracts** (from the ENS deployments page at https://docs.ens.domains/learn/deployments, read via a summary; re-check before signing):

| Contract | Address |
| --- | --- |
| ETHRegistry (holds `nanitecom.eth`) | `0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4` |
| ETHRegistrar | `0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3` |
| VerifiableFactory | `0xda70306c98e97ece36f997a21368e53298572991` |
| UserRegistryImpl | `0x9bd8a88719068d09ecee662f36c0e3856708366a` |
| PermissionedResolverImpl | `0x115eb53f0c60696633855f90b138178fb40b2b2c` |
| UniversalResolverV2 | `0x24e1d8e068620b647ca097f961a61055f4f42d72` |
| RootRegistry | `0xb458d6a3a77919449d03e7a6903c26827c1ec43f` |
| MockUSDC (6 decimals, open `mint(address,uint256)`) | `0x240b0316df57887dbbe58b586508b19e633a14aa` |

**ENSv2 interfaces** (from the ENS docs pages for Verifiable Factory, Registry Template, Permissioned Registry and Permissioned Resolver; confirm against the deployed ABI in task T0.4):

- `VerifiableFactory.deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)`. Any account can call it. The factory computes `outerSalt = keccak256(abi.encode(msg.sender, salt))`, so each deployer has its own salt space and any `uint256` salt is allowed. It emits `ProxyDeployed(sender, proxyAddress, salt, implementation)`. The address can be predicted off-chain (CREATE2 using `proxyLogic()`), and `verifyContract(proxy)` checks a proxy.
- UserRegistry: `initialize(Grant[] grants)` with `Grant = {account, roleBitmap}`. It reverts with `InvalidOwner` if no roles end up on `ROOT_RESOURCE`.
- PermissionedResolver: `initialize(Grant[] grants, bytes[] calls)`. The `calls` run as initial record writes.
- `ALL_ROLES = 0x1111…1111` (256-bit) grants every role and its admin counterpart. A role's admin is `role << 128`.
- Registry roles: `ROLE_REGISTRAR`, `ROLE_UNREGISTER`, `ROLE_RENEW`, `ROLE_SET_RESOLVER`, `ROLE_SET_SUBREGISTRY`, `ROLE_CAN_TRANSFER_ADMIN`, `ROLE_UPGRADE`, `ROLE_REGISTER_RESERVED`.
- Registry functions: `register(label, owner, registry, resolver, roleBitmap, expiry)` (needs `ROLE_REGISTRAR` on `ROOT_RESOURCE`), `setSubregistry(anyId, registry)`, `setResolver(anyId, resolver)`, `renew(anyId, newExpiry)`, `unregister(anyId)`, `grantRoles(anyId, roleBitmap, account)`, `revokeRoles(...)`, `grantRootRoles(roleBitmap, account)`, `revokeRootRoles(...)`. `anyId` can be a labelhash, token id or resource. Admin roles on individual names can only be granted at registration time.
- Resolver roles: `ROLE_SET_TEXT` (`1 << 4`), scoped by text key (resource is `keccak256(bytes(key))`); `ROLE_SET_ADDRESS` (`1 << 0`), scoped by coin type. Resources do not depend on the name, so one resolver serving several names shares permissions across them; this is why each agent gets its own resolver proxy. `grantSetterRoles(setter calldata, account)` grants a key-scoped role. A write succeeds if the account holds the role on the argument's resource or on `ROOT_RESOURCE`.

**Arkiv behaviour confirmed in T0.3 (Rabdi testnet, `@arkiv-network/sdk@1.0.1`; evidence in `docs/arkiv-spike/W0.md` to `W4.md`):**

- Rabdi: chain `7794095`, RPC `https://rpc.rabdi.db-chain.testnet.arkiv.network`, explorer `https://rabdi.explorer.arkiv.network`, gas in tGLM at a flat 1 gwei, 2-second blocks. Arkiv test wallets are listed in `docs/wallets.md` (seed `ARKIV_TEST_MNEMONIC` in `.env`).
- Schema `nanite.email.v0` (`scripts/arkiv/schema.ts`) works. Values must be wrapped (`addr()`, `u64()`). Literals in raw queries: `str('x')`, `u64(5)`, unquoted `addr(0x…)`. Raw `ORDER BY` needs the type (`receivedAt:u64`).
- **Size:** the effective maximum is about 128.2K ciphertext bytes per create (the tx size cap), not 128 KiB. Budget about 125 KiB per entity. Larger mail needs chunking or Swarm.
- **Cost:** about 164k gas + about 40 gas per byte. A typical 24 KiB encrypted email costs about 0.001 tGLM. Longer expiry costs more (+47% for 30 days against 1 hour). Batching saves about 1.5% and is capped by the same tx size.
- **Expiry:** exact to the block; an entity is gone from queries within seconds of `$expiresAt` and can't be revived. Maximum lifetime 7,884,000 blocks (about 182.5 days). `extendEntity` counts from now and can't shorten. There's no expiry event. Expired data stays readable in the creating tx's calldata.
- **Ownership:** create has no owner param, so the sender is the creator and initial owner. `executeBatch` can create and `changeOwnership` in one tx (`predictEntityKeys` first). After the transfer only the owner can patch, delete, extend or transfer; `$creator` never changes. `permissionlessExtension` (passed as `{ permissionlessExtension: true }`) lets anyone extend, including the operator; nobody can shorten. `readonly` freezes attributes.
- **Nonce race:** key prediction depends on the sender's nonce, so concurrent batches from one sender fail (safely, as an atomic revert). Operator writes must go through a single-flight queue.
- **Poisoning:** anyone can write entities with our schema and attributes. Every query must pin `$creator = addr(<operator>)`. `$owner` is not enough, since an attacker could transfer a fake entity to a victim. The SDK's look-alike skip checks only the shape.
- **Latency:** an entity is readable 0.3–1.3 s after the receipt and queryable within 0.6–2.2 s. Reads straight after a write need polling.
- **Access keys** are RPC rate-limit keys only; there is no signing delegation.

## Resolved decisions

- Email: Resend inbound for the MVP, behind a provider interface. One shared domain for the demo.
- Encryption: envelope encryption per email, content key sealed per reader (user, agent); claim is end-to-end from the moment of receipt.
- Keys: browser-generated X25519 key wrapped by a dedicated wallet signature plus a recovery code; agent wallets and keys derived by index from one seed; passphrase fallback.
- Agent access: hosted API as the default, with a `custody = nanite | self` flag; self-hosted container and SDK are advanced.
- Data split: Postgres for routing and wrapped keys only; email content on Arkiv.
- ENS: build on Sepolia; the registry for `nanitecom.eth` is a UserRegistry via the Verifiable Factory; the operator holds only `ROLE_REGISTRAR | ROLE_RENEW`; a resolver proxy per agent; per-agent salts are fine.
- The same wallet owns the Sepolia and mainnet names; accepted by the team, with the security rules above.
- ENS call order (T0.4): the operator deploys an agent's resolver proxy first (deterministic salt, with initial records), then registers the name with that resolver set, then calls `grantSetterRoles` for the agent's allowed keys. This needs no `ROLE_SET_RESOLVER` for the operator and no extra user signature.
- Arkiv writer model (confirmed by Vikrant, Nov 5, 2026, after T0.3):
  - **Writes:** the Nanite operator creates each email entity and transfers it to the user's wallet in the same `executeBatch`, so `$creator` = operator and `$owner` = user. After that the operator cannot patch, delete or take back the entity (tested).
  - **Extension:** conversation and sent mail get `permissionlessExtension` so an operator job can extend it; OTPs never do.
  - **Users:** they need no tGLM and sign nothing for mail. Only optional owner actions (delete, transfer) need their wallet.
  - **Trust:** we trust the operator for what it writes (it could insert fake mail); DKIM verification (S3) is the later fix.
  - **Rules for operator writes:** single-flight per operator account; never use the 2-transaction fallback; every query pins `$creator = operator` (and `$owner = user` for user views).
- Client-side decryption (confirmed Nov 5, 2026):
  - **Session:** one wallet signature per session (no gas). The private key lives in memory only.
  - **Reads:** the browser reads Arkiv directly and decrypts locally (sealed box, then AEAD); agents decrypt with their own key.
  - **Crypto:** `libsodium-wrappers` shared by browser and server.
  - **Required protections:** render email HTML in a sandboxed iframe, sanitized, with remote images blocked by default; strict CSP and no third-party scripts; SRI. State the "served JS is trusted" limit honestly in the docs.
- ENS roles (confirmed by Vikrant, Nov 6, 2026, after T2.1):
  - **User's name** (in the nanitecom registry): the user gets D3 (SET_RESOLVER and SET_SUBREGISTRY with their admins, plus CAN_TRANSFER_ADMIN) **plus RENEW**, so users can keep their name alive without Nanite. The operator keeps its root RENEW for auto-renewal.
  - **User's own registry:** the user holds ALL_ROLES. The operator holds REGISTRAR | RENEW | SET_PARENT | UNREGISTER (no admin roles), so the dashboard can link the registry and delete agent names without a user signature; the user can revoke any of these.
  - **Agent names:** owned by the user. Each agent's own resolver grants the operator and the user SET_TEXT | SET_ADDRESS with their admins; nobody gets UPGRADE. The agent wallet may write only `agent-context`.
- Outbound email (added Nov 5, 2026): agents can send to anyone, permitted per agent by ENS text records (`nanite.send`, `nanite.send-allow`, `nanite.send-limit`) on the agent's own resolver. Only the user and operator can set them; the agent cannot. Nanite resolves them fresh before every send. Default `reply-only`. Sent copies go to Arkiv as `type = "sent"`. Tasks: T2.2 (records) and T3.5 (send API).
- Hosting (revised Nov 6, 2026; supersedes the Vercel-for-everything decision of Nov 5):
  - **Frontend:** Next.js `apps/web` on **Vercel**. It holds only public config (API base URL, chain IDs, contract addresses); no server secrets go to Vercel.
  - **Backend:** a long-running **API service** (`apps/api`, Node + Hono) plus **Postgres 17.6**, both in Docker Compose on an **AWS Lightsail $12 instance** (2 GB RAM, 60 GB SSD; paid from the $100 AWS credits). Caddy terminates HTTPS on `api.<domain>` via a free Lightsail static IP.
  - **What the API owns:** the Resend webhook, `/v1/*`, the Arkiv single-flight write queue (in process) and the retention timer.
  - **Images and backups:** images build in GitHub Actions and push to GHCR; the VM only pulls. Backups are nightly `pg_dump` plus Lightsail snapshots. Server secrets (operator key, master key, Resend key, sender-hash secret) live only in the VM's env.
  - **Browser to API:** either a Vercel rewrite of `/api/*` to `https://api.<domain>` (no CORS) or CORS restricted to the Vercel domain. Decide in T0.5.
  - **Why:** production matches the local Docker stack, there are no serverless timeouts, and the credits cover about 8 months. Check the vCPU count and credit expiry in the AWS console.
  - **Rejected:** Cloudflare Workers free (10 ms CPU per request) and Neon (Postgres stays on the VM).
  - **Still to decide:** the domain/subdomain plan (Vercel app, `api.` to Lightsail, Resend MX for mail).
- License: MIT (Vikrant Singh, 2026).
- Design: the "Secure terminal" visual direction (dark, precise, monospace accents, hairline grids, signal-green or amber highlights) on shadcn/ui and Tailwind v4. Design guidance comes from taste-skill, Anthropic's frontend-design skill and the shadcn skill (downloaded to the gitignored `.design-refs/`). Playwright (in Docker) does visual and frontend validation.
- Runtime: Docker for everything (decided Nov 5, 2026). Nothing project-related runs on the host Mac, including checks, downloads and Playwright. T0.2 should set up Docker Compose so `docker compose up` runs the app, API and Postgres.

## Still open (each is covered by a task)

- Retention: whether to run an extend job (about every 150 days, about 0.0014 tGLM per email per year), and how long to keep conversation mail by default. Task T1.3/T4.1.
- Plaintext metadata on Arkiv (`agentId` as an ENS name, `receivedAt`, `threadId`, a global `senderHash`) is linkable by anyone. T0.3 proposes a per-user HMAC key for `senderHash` and opaque IDs in production, keeping ENS names for the demo. Decide in T1.4.
- Role set for real users on their `username.nanitecom.eth` (T0.4 used D3 = SET_RESOLVER | SET_SUBREGISTRY + admins + CAN_TRANSFER_ADMIN), and whether users also get `ROLE_RENEW` so their names survive without Nanite. Task T2.1.
- Closed in T0.4: the owner holds `ROLE_SET_SUBREGISTRY` (yes); the operator can call `register()` directly (yes); exact ABIs are saved in `contracts/abi/`.
- Whether Swarm is worth the $500 bonus; decide after Phase 3.
- Resend: the real domain (the demo address), whether a subdomain uses a domain slot (check with `resend usage`).

## Decisions 2026-11-06 (Vikrant)
- Inbound HTML: text only for now. The pipeline stores the text part (or HTML stripped to text); the HTML part isn't stored. The sandboxed iframe stays in the UI for later.
- Demo database: keep the live/demo data in the separate `nanite_live` database; the deployed API (T4.3) gets a clean database.
- Threading: outbound replies set `In-Reply-To`/`References` from the encrypted `meta.messageId`/`meta.references` of the email being answered.
- Send-log allowlist snapshot: keep counts + hash (no addresses in Postgres).
- Mail quota: one Nanite-wide cap of 90 mails/day (sent + received, all agents; Resend free tier is 100/day), configurable as `DAILY_MAIL_QUOTA`. Over the cap, outbound is refused; inbound is still stored. The per-agent ENS `nanite.send-limit` still applies. Both checks are atomic.
- Outbound signing: option B (Vikrant, 2026-11-06). A server-generated per-agent signer key, sealed under NANITE_MASTER_KEY, address published as ENS text `nanite.signer`; the derived wallet stays the identity and its key never leaves the browser. One migration (nullable signer columns) approved with B.
- Custom domain in onboarding (Vikrant, 2026-11-06): every user must add their own mail domain during onboarding. Nanite creates it in Resend through the API (sending + receiving, tracking off), shows the DNS records with provider tips, checks public DNS per record, triggers Resend verify and polls with backoff (plus the `domain.updated` webhook event); the step is resumable. New agents get `<agent>@<user domain>`. One migration adds the `user_domains` table (approved). Constraint: Resend free plan = 3 domains (1 used by nanitecom.itsvikrant.tech), so real users need Resend Pro; tests use the fake Resend.
- REVISED (Vikrant, 2026-11-06, replaces "custom domain REQUIRED"): the domain is OPTIONAL. No user is forced through the domain setup. The onboarding domain step offers a choice: "Use your own domain" (recommended; DNS can take up to 72 hours to reach the internet) or the faster route: start now with `<agent>.<user>@nanitecom.itsvikrant.tech`, zero setup. Users can add their own domain later from Settings. Onboarding completes without a verified domain; agents use the user's domain only once it is verified, otherwise the shared domain. The Resend 3-domain free limit only affects users who opt in.
- Self-hosted agents (Vikrant, 2026-11-06): build the self-hosted agent kit. The agent's encryption key AND signer key are generated on the agent's machine (`nanite-mcp keygen`); only public values reach Nanite (the encryption public key is stored, the signer address is published as `nanite.signer` by the operator). The MCP server gets a local-decrypt mode (fetch `?raw=1`, decrypt, extract OTPs and mark content untrusted locally) and the agent signs its own outbound mail (v3), which the API verifies against `nanite.signer` before sending. The web add-agent flow offers "Hold the key yourself". Also fix the hosted MCP gaps: send_email and get_latest_otp tools, a hosted Streamable HTTP `/mcp` endpoint (agent token auth), and a real `agent-endpoint[mcp]` record.
- Email expiry control (Vikrant, 2026-11-06): OTP lifetime per agent via ENS `nanite.otp-ttl` (1–60 min, default 5; set by the user, not by the agent; OTPs are never extendable). Normal mail (conversation/sent) DEFAULT lifetime = 2 days on Arkiv (was ~182 days), overridable per agent via ENS `nanite.mail-ttl`. Agents can keep important mail with the MCP tool `extend_email` / `POST /v1/emails/:key/extend` (the operator pays; conversation/sent only; capped per call at the Arkiv maximum ~182.5 days; gated by an ENS permission with a daily limit set by the user). The user gets a Keep button in the inbox. Expiry is shown on every email.
