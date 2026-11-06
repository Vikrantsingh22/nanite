/*
 * DEV/TEST ONLY. Provisions a custody=nanite key for the seeded agent alex (fresh X25519 keypair:
 * public key + master-key-sealed private key stored in the database) and prints an API token ONCE.
 * The token is a test credential. Re-running replaces alex's key (older mail becomes unreadable
 * for alex) and issues another token.
 *
 *   NANITE_MASTER_KEY=$(openssl rand -hex 32) must be the SAME value the api runs with.
 *   docker compose run --rm tools npx tsx apps/api/scripts/issue-dev-token.ts
 */
import { pathToFileURL } from "node:url";
import { createDb, seedDemo } from "@nanite/db";
import { parseMasterKey, provisionNaniteAgentKey } from "../src/agent-api/keys.js";
import { issueAgentToken } from "../src/agent-api/tokens.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = process.env.NANITE_MASTER_KEY;
  if (!raw) {
    console.error("NANITE_MASTER_KEY is required (32 bytes as 64 hex chars or base64).");
    process.exit(1);
  }
  const master = parseMasterKey(raw);
  const handle = createDb(process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite", { max: 1 });
  try {
    const seeded = await seedDemo(handle.db);
    const key = await provisionNaniteAgentKey(handle.db, seeded.agentId, master);
    const { token } = await issueAgentToken(handle.db, seeded.agentId, { label: "dev-token" });
    console.log(`agent alex (${seeded.mailbox}) provisioned, key ${key.keyId}`);
    console.log(`token (shown once): ${token}`);
  } finally {
    await handle.close();
  }
}
