# packages/

Shared workspace packages (npm workspaces: `packages/*`).

- `db`: Drizzle schema, migrations and queries for Postgres (routing, wrapped keys, idempotency and audit rows; never email content).
- `crypto`: envelope encryption, key wrapping and derivation, shared by browser and server (see its README).
- `arkiv`: the `nanite.email.v1` schema, a browser-safe reader (creator-pinned queries) and a server writer (create + transfer in one batch, single-flight queue).
- `ens`: server-side ENSv2 service on Sepolia: user and agent names, role design, send-policy records, resolve and revoke.
- `mcp`: `@nanite/mcp`, a stdio MCP server exposing the read-only agent API (`list_inbox`, `get_email`, `latest_otp`, `wait_for_email`).
