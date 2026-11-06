# ENSv2 in Nanite

Nanite runs on the ENSv2 deployment on **Sepolia** (chain 11155111) under `nanitecom.eth`. Every agent is a name `agent.username.nanitecom.eth`; ENS holds its identity, its permissions and its send policy. Code: `packages/ens` (see its README for the call order and gas costs). Contract addresses: `config/sepolia.json`; ABIs: `contracts/abi/` (from `ensdomains/contracts-v2` at commit `07e55a05`); role values: `config/roles.json`.

## Deployment used

| Item | Address (Sepolia) |
| --- | --- |
| Owner of `nanitecom.eth` (signs only in a browser wallet) | see `docs/wallets.md` |
| `nanitecom.eth` UserRegistry proxy (subnames live here) | `0xD2BE04253E815972D6a1D995670eBAc7a6C8C786` |
| Nanite operator (holds only root `ROLE_REGISTRAR \| ROLE_RENEW` here) | see `docs/wallets.md` |
| ETHRegistry | `0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4` |
| UniversalResolverV2 | `0x24e1d8e068620b647ca097f961a61055f4f42d72` |
| VerifiableFactory | `0xda70306c98e97ece36f997a21368e53298572991` |
| PermissionedResolver implementation | `0x115eb53f0c60696633855f90b138178fb40b2b2c` |
| UserRegistry implementation | `0x9bd8a88719068d09ecee662f36c0e3856708366a` |

Each user gets their own registry (a UserRegistry proxy) holding their agent names, and each agent gets its own PermissionedResolver proxy. Resolver roles are scoped per text key, not per name, so one resolver per agent is what makes "this agent may write only `agent-context`" enforceable.

## Roles

| Where | Who | Roles |
| --- | --- | --- |
| `username.nanitecom.eth` token | user | SET_RESOLVER, SET_SUBREGISTRY (+ admins), CAN_TRANSFER_ADMIN, plus RENEW so the name survives without Nanite |
| user's own registry | user | ALL_ROLES (can eject the operator) |
| user's own registry | operator | REGISTRAR, RENEW, SET_PARENT, UNREGISTER (no admin roles) |
| `agent.username.nanitecom.eth` token | user | SET_RESOLVER (+ admin), CAN_TRANSFER_ADMIN; the agent wallet never owns its name |
| agent's resolver | user and operator | SET_TEXT, SET_ADDRESS (+ admins); nobody gets UPGRADE |
| agent's resolver | agent wallet | `SET_TEXT` on the key `agent-context` only |

Role bitmaps are fixed constants in `packages/ens/src/roles.ts`, never built from caller input, because `register()` hands out whatever bitmap it is given. Child expiry is clamped to the parent's (the contracts do not check it).

## Records on an agent's resolver

| Key | Meaning | Writable by agent? |
| --- | --- | --- |
| `addr` (coin 60) | agent wallet | no |
| `email` | mailbox address | no |
| `nanite.pubkey` | agent X25519 public key, 64 hex, no `0x` | no |
| `agent-context` | free text for the agent | yes |
| `agent-endpoint[mcp]` | the hosted MCP endpoint, `<API_PUBLIC_URL>/mcp` (Streamable HTTP, agent bearer token; self-hosted agents use local mode) | no |
| `nanite.send` | `off`, `reply-only` (default), `allowlist`, `any` | no |
| `nanite.send-allow` | comma list of `addr@x.com`, `@domain`, `name.eth` | no |
| `nanite.send-limit` | sends per UTC day, 0 to 10000 (default 50) | no |
| `nanite.otp-ttl` | OTP lifetime in minutes, integer 1 to 60 (default 5) | no |
| `nanite.mail-ttl` | lifetime of conversation and sent mail in hours, integer 1 to 4380 (default 48) | no |
| `nanite.extend` | `on` (default) or `off`: may the agent extend mail (`POST /v1/emails/:key/extend`, MCP `extend_email`) | no |
| `nanite.extend-limit` | agent extensions per UTC day, integer 0 to 1000 (default 20) | no |
| `nanite.signer` | checksummed address of the key that signs this agent's outgoing mail (`X-Nanite-Signature`); for a self-hosted agent this is the address of the key it generated itself (`nanite-mcp keygen`) | no |

The four retention records are optional (not written when the agent is created); missing or invalid values read as the defaults (`readRetentionPolicy` in `@nanite/ens` returns the parsed policy plus a count of invalid records, which the API logs as a number only). They are written by the operator on the user's request (`setRetentionPolicy`, dashboard "Retention", `PUT /agents/:id/retention`); the agent wallet holds `SET_TEXT` for `agent-context` only, so it cannot write them (covered by `getAgentPermissions` tests). Lifetime changes apply to new mail; the API caches a policy for at most 60 s per agent when writing mail, and reads `nanite.extend` and `nanite.extend-limit` fresh on every extend call.

`nanite.signer` is written by the operator (root `SET_TEXT`) when the agent is created, or later by `POST /agents/:id/signer`, which also rotates it. For a Nanite-held agent the signer key is a server-held secp256k1 key sealed under `NANITE_MASTER_KEY`. For a self-hosted agent (`custody = self`) the key is generated on the agent's machine and the dashboard sends only its address (`signerAddress` on create, `{address}` on rotate); the operator publishes that address and no key is stored. The API verifies a self-hosted agent's signature against this record, read fresh on every send. The agent's own wallet (`addr`) is a different key and never signs mail. A verifier resolves the agent name, reads this record and checks that the signature recovers to it: see "Verifiable outbound mail" in the README (`verifyNaniteSignature`, `apps/api/scripts/verify-mail-signature.ts`). Changing the record invalidates every signature made with the previous key. The current format is signature v3: the signed string ends with the `X-Nanite-Message-Id` header (our own id) instead of `Message-ID`, because Resend/Amazon SES replace `Message-ID` on delivery (v2 mail through Resend cannot verify; the verifier says so in its `hint`). Headers and string: README, "Verifiable outbound mail".

`agent-endpoint[mcp]` is written when the agent is created, as `<API_PUBLIC_URL>/mcp` (`API_PUBLIC_URL` = the public https URL of the API, no trailing slash; default `http://localhost:4000`). Agents created before the hosted endpoint existed carry the old placeholder; `apps/api/scripts/update-agent-endpoints.ts` lists them (dry run) and rewrites them with `--apply` (operator transactions, resumable, run it at deploy time).

The API reads the three `nanite.send*` records fresh from ENS before every send and fails closed (unreadable means no send; an invalid value means `off`).

## Resolve an agent

Resolution goes through UniversalResolverV2, which walks the subregistry chain (root, ETHRegistry, nanitecom registry, user registry). With viem, pass the resolver explicitly:

```ts
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
const client = createPublicClient({ chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com"), cacheTime: 0 });
const universalResolverAddress = "0x24e1d8e068620b647ca097f961a61055f4f42d72";
const name = "alex.t21test.nanitecom.eth";
await client.getEnsAddress({ name, universalResolverAddress });
await client.getEnsText({ name, key: "nanite.send", universalResolverAddress });
```

In this repo: `ens.resolveAgent("alex.t21test.nanitecom.eth")` from `@nanite/ens` returns `{address, email, pubkey, sendPolicy, agentContext, endpoint}`. The public Sepolia RPC can serve stale reads for a few seconds after a transaction.

## Real names on Sepolia

Read-only lookups run on 2026-11-06 through UniversalResolverV2 (inside Docker, nothing sent):

| Name | `addr` | `email` | `nanite.send` | `nanite.send-allow` | `nanite.send-limit` |
| --- | --- | --- | --- | --- | --- |
| `alex.t21test.nanitecom.eth` | agent index 0 | `alex.t21test@nanite.test` | `allowlist` | `friend@example.com` | `50` |
| `alex.t22test.nanitecom.eth` | agent index 0 | `alex.t22test@nanite.test` | `reply-only` | (empty) | `50` |

- `alex.t21test`: user registry `0x8f6Cad323c26275068E64A08b348D73B6aA48C71`, agent resolver `0xCAf9CD2CA1CA0F325c6E6baBdfFdDaF745fd588b`. The API sent to `friend@example.com` (200) and refused `stranger@example.com` (403) with a fake mail provider (`apps/api/LIVE-CHECK.md`).
- `alex.t22test`: user registry `0x8def12c7B761a7e71e2653B7855279B4560548Bb`, agent resolver `0xDd458049F530c50a7e513045B04Db3717F2027a6`. Its agent role was revoked at the end of the live test, so the agent wallet can no longer write `agent-context` (`EACUnauthorizedAccountRoles`). Before the revoke the agent's own `setText(agent-context)` succeeded, while `setText(email)`, `setText(nanite.send)` and `setAddress(60)` reverted (`packages/ens/live-check.md`, tx hashes included).
- Both names use the test user as owner and agent index 0 as the agent wallet (`addr` resolved to the agent index 0 address in `docs/wallets.md`; the lookup matched). `@nanite.test` is a placeholder mail domain, not a real mailbox.

## Surprises (ENSv2 friction)

Full list in [arkiv/build-notes.md](../arkiv/build-notes.md) (section on ENS v2). The ones that shaped the design: setter functions take a DNS-encoded name first (`setText(bytes,string,string)`); `grantSetterRoles` takes full setter calldata and scopes by key only; no parent-expiry check; `register()` grants any role bitmap with no caller-side check; the resolver skips role checks during `initialize`.
