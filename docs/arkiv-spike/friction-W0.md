# Friction (W0)

- SDK version rule: latest 1.0.1 was published 2026-11-02 (3 days old); 1.0.0 on 2026-10-30. The "2 weeks old" rule would force 0.8.1, which predates `defineSchema`/`rabdi({accessKey})` as documented, so 1.0.1 was pinned deliberately (exact).
- Docs vs SDK drift: docs llms.txt lists `not`, `ne`, pagination `next`/`cursor`/`atBlock`/`for await`; 1.0.1 src has none of them (offset paging only, no `ne`/`not`). Docs seem ahead of the published package or describe a different version.
- `rabdi()` requires an argument and throws `MissingAccessKeyError` without `{accessKey}`; the public endpoint needs explicit `""`, and it console.warns at import-time use. Easy to trip on; the docs' quickstart should say so.
- `createEntity` has no owner param; user ownership with an operator writer needs create + changeOwnership (batchable), and the random default salt forces `predictEntityKeys` to reference the key inside the same batch.
- Rabdi RPC (https://rpc.rabdi.db-chain.testnet.arkiv.network) and explorer timed out from this machine (host and Docker) throughout W0, from curl and viem, while docs.arkiv.network answered. Connectivity checks could not be completed. Retry; maybe get an access key (hub.arkiv.network/access-keys).
- Docs site pages are HTML-only for curl (no raw markdown found), noisy to read in the terminal; the package's shipped `src/` was the most useful reference.
- viem pinned at 2.21.54 in this repo while the SDK's own dev dependency is ^2.38.2; peer range ^2.0.0 so it typechecks. Not upgraded.
