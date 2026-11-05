# @nanite/ens

Server-side ENSv2 service for Nanite (Sepolia, operator wallet). ESM, TypeScript strict. Never touches the owner wallet.

```ts
import { loadEnsConfig, createEnsServiceFromConfig } from "@nanite/ens";
const ens = createEnsServiceFromConfig(loadEnsConfig()); // needs OPERATOR_PRIVATE_KEY, SEPOLIA_RPC_URL, API_PUBLIC_URL
await ens.createUserName({ username, userWallet });
await ens.createAgentName({ username, agentLabel, agentWallet, email, encryptionPublicKeyHex, sendPolicy: "reply-only" });
await ens.setSendPolicy({ username, agentLabel, policy: "allowlist", allow: ["a@b.com", "@corp.io"], limit: 20 });
await ens.readSendPolicy("alex.vikrant.nanitecom.eth");   // fresh, typed, fails closed
await ens.resolveAgent("alex.vikrant.nanitecom.eth");     // {address, email, pubkey, sendPolicy, agentContext, endpoint}
await ens.revokeAgent({ username, agentLabel, unregister: false });
```

Config: addresses from `config/sepolia.json`, ABIs from `contracts/abi/`, roles from `config/roles.json` (all imported statically), the nanitecom UserRegistry proxy `0xD2BE...C786` (override with `NANITE_PARENT_REGISTRY`), parent expiry read live from the ETHRegistry. `encryptionPublicKeyHex` is a 32-byte X25519 key; it is stored in `nanite.pubkey` as lowercase hex WITHOUT `0x`.

## Role design (src/roles.ts)

Registry `register()` hands the new owner whatever bitmap it is given, so no bitmap is ever built from caller input; only these named constants are used.

| Where | Who | Roles | Why |
| --- | --- | --- | --- |
| `<user>.nanitecom.eth` token | user | `USER_NAME_ROLES` = D3 (SET_RESOLVER, SET_SUBREGISTRY + admins, CAN_TRANSFER_ADMIN) plus plain RENEW (no admin) | user controls and can move their name, and can renew it themselves so it survives without Nanite (the operator keeps its root RENEW for auto-renewal). No UPGRADE, UNREGISTER or REGISTRAR |
| user's own registry (root) | user | ALL_ROLES | the user owns their namespace outright and can eject the operator |
| user's own registry (root) | operator | REGISTRAR, RENEW, SET_PARENT, UNREGISTER (`0x11101`, no admin roles) | REGISTRAR/RENEW: add and keep agent names with no user signature. SET_PARENT: one-time `setParent(nanitecom registry, username)` so the registry knows its canonical name without a user signature (user holds the admin role and can revoke it). UNREGISTER: dashboard revoke-with-unregister without a signature. Worst case of a leaked key here: junk or removed agent names inside one user's namespace; it cannot take the user name, change resolvers, or upgrade |
| `<agent>.<user>.nanitecom.eth` token | user (owner) | `AGENT_NAME_ROLES`: SET_RESOLVER (+admin), CAN_TRANSFER_ADMIN | the agent name token belongs to the USER, never the agent wallet, so the agent cannot repoint or sell itself. No SUBREGISTRY (agent names have no children) |
| agent's own resolver (root) | operator and user | SET_TEXT, SET_ADDRESS + admins (`RESOLVER_GRANTS`); never UPGRADE | operator writes records and send policy; user can too |
| agent's resolver, key-scoped | agent wallet | `ROLE_SET_TEXT` on the keys in `AGENT_SETTER_KEYS` = `["agent-context"]` only | resolver roles are per key, not per name, hence one resolver per agent. The agent cannot write `email`, `addr`, `nanite.pubkey` or any `nanite.send*` key |

## Call order and idempotency

`createUserName`: (1) `deployProxy` of the user's UserRegistry via VerifiableFactory (deployer = operator, salt `keccak("nanite:user-registry:<username>:v1")`, grants above); (2) `setParent` on it; (3) `register(username, userWallet, userRegistry, 0x0, USER_NAME_ROLES, expiry)` in the nanitecom registry.
`createAgentName`: (1) deploy the agent's PermissionedResolver proxy (salt `keccak("nanite:agent-resolver:<username>:<agent>:v1")`) with `initialize(grants, calls)` writing addr(60), email, nanite.pubkey, agent-context, agent-endpoint[mcp], nanite.send, nanite.send-allow (empty), nanite.send-limit (50); (2) `register(agent, userWallet, 0x0, resolver, AGENT_NAME_ROLES, expiry)` in the user's registry (needs only the operator's REGISTRAR there); (3) `grantSetterRoles` for the agent wallet per `AGENT_SETTER_KEYS`. The user wallet is read from the username token owner. This is the ENS call order from T0.4: no ROLE_SET_RESOLVER and no extra user signature.

Both return `{ txHashes, skipped, gasUsed, ... }`. Every step first checks on-chain state (code at the predicted proxy, `getParent`, `getState`, `hasRoles`) and is skipped when done, so a crashed run is resumed by calling again. A registered name owned by someone else, or with a different registry/resolver, throws. Expiry is `min(now + 1 year, parent expiry)` (agent: clamped to the user name's expiry) and `<= now` is rejected. Every send is simulated first and sends nothing if the simulation fails; sends are single-flight per process (one nonce). Reads right after a receipt can be stale on the public RPC: sends retry their simulation, deploys poll for code, and `createAgentName` polls for the just-registered username.

## Send policy

Keys `nanite.send` (`off|reply-only|allowlist|any`), `nanite.send-allow` (comma list of `addr@x.com`, `@domain`, `name.eth`), `nanite.send-limit` (0..10000/day). `readSendPolicy` uses a viem client with `cacheTime: 0` via UniversalResolverV2. Parsing fails closed: missing policy means `reply-only`, a present-but-invalid value means `off`, bad limit means 0, bad allowlist means empty. `setSendPolicy` validates input and writes one `setText` per provided field.

## Mail signature (`nanite.signer`)

`publishSigner({username, agentLabel, address})` writes the checksummed address to the text record `nanite.signer` (operator `setText`; skipped when a fresh read already equals the address, so it is resumable). `readSigner(name)` is the fresh read. `src/signature.ts` holds the shared pieces: `canonicalSendStringV2` (`nanite-send-v2\n<ens>\n<from>\n<to>\n<sha256(subject)>\n<sha256(body)>\n<date>\n<message-id>`, built by the API when signing and by every verifier) and `verifyNaniteSignature({headers, from, to, subject, body}, {ensClient})` returning `{valid, agent, signer, reason}`. `ensClient` is anything with `getText(name, key)`; `createSepoliaNameReader(rpcUrl?)` is the read-only UniversalResolverV2 one. They live here, not in the API, because sender and verifier must agree on the exact string and this package already owns the record and the resolver reads.

## Revoke

`revokeAgent` calls `revokeRoles(keccak(key), SET_TEXT, agentWallet)` on the agent's resolver for each setter key (agent wallet from `addr` unless `agentWallet` is passed), optionally `unregister(labelhash)` on the user registry. Revoking does not remove the API token or the Postgres rows; that is for the caller (T2.2/T3.x).

## Permissions helper

`getAgentPermissions("alex.vikrant.nanitecom.eth", account)` returns `{ text: {key: boolean}, address: boolean }` for every managed record (`AGENT_TEXT_KEYS`) using fresh `hasRoles`/`hasRootRoles` reads on the agent's resolver (nothing is sent). The dashboard permission matrix uses it. The T2.2 opt-in live test is `test/ens.live.test.ts` (`LIVE_ENS=1`, results in `live-check.md`).

## Tests and live check

`npm test -w packages/ens` (vitest, fake chain: expiry clamp, bitmaps, salts, resumability, policy parsing). Live: `docker compose run --rm tools npx tsx packages/ens/scripts/live-check.ts --yes` (real Sepolia txs, idempotent). Results and tx hashes: `live-check.md`.

## Costs observed (gas, Sepolia)

User registry deploy 1.02M, setParent 0.25M, register user name 0.72M; agent resolver deploy with 8 records 2.44M, register agent 0.61M, grantSetterRoles 0.26M; setText 45k to 150k; revokeRoles 46k. About 5.0M gas for a full user + first agent. Sepolia gas price was negligible; on a real network the resolver proxy deploy dominates (consider fewer initial records or batching agents if cost matters).
