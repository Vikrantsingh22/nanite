# Build notes: ENS, tooling and our own bugs

These things slowed us down while building Nanite. None of them is an Arkiv issue, so they are kept out of [friction.md](friction.md).

## ENS v2 contracts (Sepolia)

Where these come from: the ABI and function-signature notes come from the deployment files at the commit we pinned (`ensdomains/contracts-v2` at `07e55a05`; compared in [docs/abi-check.md](../docs/abi-check.md)). The contract behaviour notes come from reading the ENS v2 contract source at that commit, not from the docs. The expiry and role notes were also confirmed by a read-only simulation of `register()` on Sepolia (`scripts/ens/simulate-register.ts`, [docs/logbook.md](../docs/logbook.md) T0.4 step 8). The RPC lag note was observed while building.

- The `contracts-v2` repo is public at github.com/ensdomains/contracts-v2. The Sepolia deployment files sit in `contracts/deployments/sepolia/*.json`, not in a top-level `deployments/` folder.
- The VerifiableFactory source is a git submodule, so it is missing from the download. We pulled it out of `deployments/sepolia/build-info/*.json` (`input.sources`).
- The docs show `setText(key,value)` and `setAddr`. The real functions are `setText(bytes name,string key,string value)` and `setAddress(bytes name,uint256 coinType,bytes)`. The first argument is the name in DNS encoding.
- `grantSetterRoles(bytes setter, address)` takes the full encoded call of a setter. The docs do not make this clear.
- `PermissionedRegistry._register` does not check the parent's expiry, so a subname can outlive `nanitecom.eth`. Only the source shows this. Our code limits a subname to the parent's expiry.
- The past-expiry check uses `block.timestamp >= expiry`, so an expiry of exactly "now" also fails (`CannotSetPastExpiry`).
- The registrar's roles are granted with no check on the caller, so `ROLE_REGISTRAR` alone can hand out any role, including `ALL_ROLES`. The docs say admin roles can only be granted at registration. They do not say the registrar has no limits.
- `PermissionedResolver.initialize(grants, calls)` skips role checks while it initializes, so the first records need no role. Found only in the source.
- Setter roles from `grantSetterRoles` are tied to the record key only, not to the name. A grant for one key works on every name the resolver serves. So we use one resolver per agent.
- The "missing role" error is `EACUnauthorizedAccountRoles(resource, roles, account)`. `resource` is `uint256(keccak256(key))`, which is not readable. Decode it with `UserRegistryImpl.json`.
- The public Sepolia RPC (publicnode) lags. Right after a confirmed deploy, `getCode` came back empty and a role we had just granted read as 0. Our scripts can be re-run safely and do not trust a read made right after a receipt.

## Tooling

Observed while building.

- A named Docker volume for `node_modules` leaves an empty `node_modules` folder on the host.
- Our rule is that nothing runs on the host, so source downloads happen inside Docker. The sources sit under `contracts-v2-<sha>/contracts/src/`.
- The `tools` image has `curl` and `node` but no `jq`. So running `arkiv/query.curl.sh` inside it needs `apt-get install jq` first. The script is plain POSIX `sh`, so `bash` is not needed. Adding `jq` to the image would help.
- The `mnemonicToAccount` type in viem 2.21 does not fit the `writeContract` account parameter cleanly. Our scripts use `any` at that point.

## Our MCP kit (task T3.7)

- From building the hosted MCP route (`apps/api/src/routes/v1.ts`, see the MCP SDK's stateless transport): MCP over HTTP in stateless mode needs `enableJsonResponse`, and the client must send `Accept: application/json, text/event-stream` ([docs/mcp.md](../docs/mcp.md)). The SDK's Web-standard transport (`WebStandardStreamableHTTPServerTransport`) plugs into Hono directly, with no Express adapter.
- For self-signed sends, the Resend `send_log` id also blocks replays. If the mail provider call fails, the client's message id is used up. So the client must pick a new uuid for each attempt.
- The kit could not import `@nanite/ens` without also pulling in `config/sepolia.json`. We moved the shared v3 string to `@nanite/crypto`; `@nanite/ens` re-exports it.
- First live run, bug 1: the `nanite-mcp` launcher did not pass on its arguments, so `nanite-mcp keygen` printed an unrelated error. Fixed. The unit tests called `runKeygen` directly and never ran the launcher.
- First live run, bug 2: in local mode, `bin.ts` loaded the key file before `await ready()`, so the server stopped with "call await ready() before using @nanite/crypto". Fixed. A smoke test that starts the launcher with a generated key file would catch this.
