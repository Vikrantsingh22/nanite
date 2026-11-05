# T2.1 live check (Sepolia, 2026-11-06)

Command: `docker compose run --rm tools npx tsx packages/ens/scripts/live-check.ts --yes` (run three times: the first crashed on a stale read between createUserName and createAgentName, which led to the retry in `createAgentName`; runs 2 and 3 resumed, run 3 re-granted agent 0 after run 2's revoke so the positive check could be shown).

Names: `t21test.nanitecom.eth` (owner: test user 0xfAD3...36C0), `alex.t21test.nanitecom.eth` (owner: test user, addr = agent 0 0xC057...287b).
User registry proxy: `0x8f6Cad323c26275068E64A08b348D73B6aA48C71`. Agent resolver proxy: `0xCAf9CD2CA1CA0F325c6E6baBdfFdDaF745fd588b`. Both expire 1825432500 (clamped to the parent).

## Transactions

| Step | Gas used | Tx hash |
| --- | --- | --- |
| deploy user registry (VerifiableFactory) | 1,017,795 | 0xed9193304a04a96e2baeaad454701ee0f223f733849d9de4cc8188b0a764ed10 |
| setParent(nanitecom registry, "t21test") | 251,599 | 0x654853c9cd51f2b1bd5668b2046e0c3513cf264e63496c30d41ddfa177ef6e73 |
| register `t21test` in nanitecom registry | 716,620 | 0xbb60629528e6ed9f79ea5ce45078165d0a2e0a5880b3e5e716fc4bf5d91047c4 |
| deploy agent resolver proxy + 8 initial records | 2,442,714 | 0x22bb886463a1cf0258a7605acac6a4faa6ba1047100bc5e88c5f697efd4b02c6 |
| register `alex` in user registry | 608,640 | 0xf1cfcd5f26d88f7ad53099c763bea3cc3939e9ff8eb989f43899538af6e93868 |
| grantSetterRoles agent-context -> agent 0 (run 2) | 258,628 | 0x38953a598e3b816346d4baa3cbf35a37a86aa5dd4f4cf80874d02debad3c2b9d |
| setSendPolicy nanite.send=allowlist (run 2) | 54,656 | 0xbb23c6b1ede298683ffec166c5946ce8300c96fa9a210074c7c61bc7592db538 |
| setSendPolicy nanite.send-allow (run 2) | 152,756 | 0xaa8eb8d34e0e7c8f2f6c7a3a4756317139f05efd4a8082559520d8cae28f812d |
| revokeRoles agent-context (run 2) | 45,860 | 0x55348f7b18d7b9de2a05806638d1a811c9f6a49eeb1c3fdd2d7b632b80486294 |
| grantSetterRoles agent-context again (run 3) | 258,628 | 0x01216c5a83bc05b924fadf5ba9ac7e35efa0c8588ae79d82322b96245a491b7f |
| setSendPolicy nanite.send (run 3) | 44,656 | 0x56a33936f85a601916e9310f4df58054b72aef9c884c382949f8260a1aea8ff2 |
| setSendPolicy nanite.send-allow (run 3) | 44,836 | 0x9162c61fa70084da53941e0f8ba26e797118f1730dc1a966ca687eb645b6d953 |
| revokeRoles agent-context (run 3, final state: revoked) | 45,860 | 0x94c96d435f31c3913023a49b4c03ffed8f2a7ee71d7fa335ffb181e456a32245 |

Full create path (user name + agent name): about 5.04M gas (user 1.99M, agent 3.31M); the resolver proxy deploy with initial records is the big item (2.44M). Sepolia gas price was negligible (operator balance stayed about 0.5 ETH).

## resolveAgent("alex.t21test.nanitecom.eth") through UniversalResolverV2

```
address:      0xC0575045B1acacC1349e3e5f8bE20FBA3a8E287b
email:        alex.t21test@nanite.test
pubkey:       448a43f9ef4fcf83699b4e214ba8652c84e50469f7cf46409dcf3c993affbf20
sendPolicy:   { policy: "reply-only", allow: [], limit: 50 }      (after run 2's setSendPolicy: allowlist, ["friend@example.com"], 50)
agentContext: "Nanite agent mailbox alex.t21test.nanitecom.eth"
endpoint:     http://localhost:4000/mcp   (agent-endpoint[mcp], API_PUBLIC_URL placeholder)
```

## Agent 0 permission simulations (eth_call, nothing sent)

Before revoke: `setText(agent-context)` OK; `setText(nanite.send)` REVERT EACUnauthorizedAccountRoles; `setText(email)` REVERT EACUnauthorizedAccountRoles.
After revoke: `setText(agent-context)` REVERT EACUnauthorizedAccountRoles; `setText(nanite.send)` REVERT.
Operator `unregister(alex)` on the user registry: simulation OK (not sent).
(In run 2 the first positive check raced a stale read and reverted; the script now polls it.)

# T2.2 live test (Sepolia, 2026-11-06)

Command: `LIVE_ENS=1 docker compose run --rm -e LIVE_ENS=1 tools npx vitest run --root packages/ens test/ens.live.test.ts` (opt-in; skipped without `LIVE_ENS=1`; do NOT combine with `npm test`). Raw trail with every tx: `packages/ens/live-t22.log` (no keys in it).

Names: `t22test.nanitecom.eth` (owner: test user 0xfAD3...36C0, holds the new RENEW role), `alex.t22test.nanitecom.eth` (agent wallet = TEST_SEED_MNEMONIC index 0, 0xC057...287b), throwaway `bob.t22test.nanitecom.eth` (index 1, 0 ETH, only the operator sends). User registry `0x8def12c7B761a7e71e2653B7855279B4560548Bb`, alex resolver `0xDd458049F530c50a7e513045B04Db3717F2027a6`; user name expiry 1825432500 (clamped to the parent).

Result: all 7 steps (a..g) passed in the last full run (steps are ordered and share state; earlier runs failed on stale public-RPC reads and on test timing, which led to retries in `revokeAgent` and polling in the test; see "Surprises").

| Step | Result |
| --- | --- |
| b. UniversalResolverV2 | addr = agent 0, email `alex.t22test@nanite.test`, nanite.pubkey 64 hex, agent-context, agent-endpoint[mcp] `.../mcp`, nanite.send `reply-only`, nanite.send-allow empty, nanite.send-limit `50` |
| c. agent 0 setText(agent-context) SENT | success; new timestamp value resolved (tx 0xbb3142ce...8f5c14, 59,999 gas, last run; first run 0x2868026b...97d7e5, 79,999 gas) |
| d. agent 0 simulations | setText(email), setText(nanite.send), setAddress(60): each REVERT EACUnauthorizedAccountRoles |
| e. renew | `hasRoles(token resource, RENEW, user)` true; user `renew(labelhash, expiry+1d)` simulation OK; agent 0 (stranger) renew REVERT EACUnauthorizedAccountRoles(.., 65536, ..) |
| f. revokeAgent(alex) | agent 0 setText(agent-context) now REVERT EACUnauthorizedAccountRoles; second revoke is a no-op (after waiting for the node to show the first) |
| g. revokeAgent(bob, unregister) | name no longer resolves (addr null); a repeat call is a clean no-op or "no resolver" |
| getAgentPermissions | agent 0: only `agent-context` true, addr false; user: all keys and addr true |

Transactions (last full run; all sent by the operator except the agent 0 setText):

| Step | Gas | Tx hash |
| --- | --- | --- |
| register `t22test` (set-parent in an earlier run, below) | 716,620 | 0x08c55cf47546c8e23ebdcffd23a4fa2f2fe8db94e54e5e56aee59c38a7c168a2 |
| setParent(nanitecom registry, "t22test") | 251,599 | 0xd9bdc6a4e328868cb7df48f3a474dae3ddf93629dd16ba0659f9a52f83919dba |
| deploy alex resolver + 8 records | 2,442,714 | 0xdfa1fc9073714d9dbbfee2e56cbbb3a5bd6369cd697be81cf3b0fd1d5c501c0a |
| register `alex` | 497,981 | 0x99f78b6a1d6d6972ffaa632ef78d0b076851c4eeac4e03376c231b70bb6860c1 |
| grantSetterRoles agent-context -> agent 0 | 258,628 | 0x4ba165387269e27e3371f4c62608d5af9cfab7754315e1205a9311c2a0d28fcc |
| agent 0 setText(agent-context) (run 1 of step c) | 79,999 | 0x2868026bcc357a8c4582c358ae96bf8f5f2ce6f5580d83f107726f447e97d7e5 |
| revokeRoles alex (run 1) | 45,860 | 0x443468dad45b391f0a3b4a8ab957be876d676de884227efc7c76648740f27bb7 |
| deploy bob resolver | 2,442,594 | 0x695828436dc6eec606c691ad4d11cc22cdea0bf6e05a89cca2fd3ec0533dfaee |
| register `bob` | 497,969 | 0x0059881df06cc886bed693c39a8514f503c323d448836855f0bf31fcc4e5e1ab |
| grantSetterRoles bob | 258,616 | 0x744af6a0ac61cb9223b46273372a6eb6762ea906620038f9cd6993045b3606c0 |
| re-grant alex (rerun) | 258,628 | 0x293f6c95cd58764f566a11e01495ee6029f4a4be88a0fac12f048e4cbfec126b |
| revokeRoles alex | 45,860 | 0xc0f2c0c6f14b97d09ef76ed2ae72d501d4df69dead347aaa2fc00dbda82d4453 |
| revokeRoles bob + unregister bob | 45,860 + 163,102 | 0xa871c366c839e14a67b860fc2977972a38e56a928a407b44f38962e7e75faa57 / 0xabfef2563c3d5e6643516b8c4ec73c0def0e7232cbaf1c2bf12f0f1ceb00bcd7 |
| re-grant alex (final full run) | 258,628 | 0xa482248213fca3d707f3bbf3f702e066ed4d6a75754293597399d59ad9b8c4a9 |
| agent 0 setText(agent-context) (final) | 59,999 | 0xbb3142ce6176af6583c70ea37f8cc98a0f9e9b61e7775a7e0e209f1e8c8f5c14 |
| revokeRoles alex (final) | 45,860 | 0xcc00f3338110337fe34375da0f0552e75d542c3162172a2018b3a86c5a286ae3 |
| re-register bob (after unregister) | 400,049 | 0x263905b23c9dba09ec62d367c1d57c67dbd84efef1bdd73f5c0571d140fc0747 |
| grantSetterRoles bob | 258,616 | 0xe5b5f46efb46778cceac26299cd7e5af49888ed3456855e312997a0b480147bd |
| revokeRoles bob + unregister bob (final) | 45,860 + 65,182 | 0xddaad5d5b449027192b6e42e37b7875a1d6939d9c1b3a97f6d85359389ad951c / 0x6459b3972335142ad53b5b369e856c4c8c89ab06459aca26f1606c29d5315ef6 |

The user registry deploy tx of `t22test` happened in a first run that crashed before logging (not recorded; the registry is `0x8def...48Bb`). Final on-chain state: alex revoked (agent 0 cannot write), bob unregistered.

Surprises: (1) the public RPC served a stale zero resolver right after `register`, so `revokeAgent` now re-reads before giving up; (2) unregistering an already-unregistered name fails the simulation with `LabelExpired`; `revokeAgent` now treats that as already done; (3) `getResolver` of an unregistered name returns zero, so a repeat revoke can say "no resolver"; (4) bob re-register after unregister is cheaper (400k gas). Running `npm test` with `LIVE_ENS=1` also runs this live test; two overlapping runs happened once (nonce-safe because of the single-flight queue, but wasteful).
