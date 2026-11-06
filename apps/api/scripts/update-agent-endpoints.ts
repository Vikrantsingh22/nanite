/*
 * Rewrite the `agent-endpoint[mcp]` ENS record of existing agents to `<API_PUBLIC_URL>/mcp` (the hosted MCP endpoint).
 * Agents created before the endpoint existed carry the old placeholder (`http://localhost:4000/mcp`). Run this at
 * deploy time, after API_PUBLIC_URL is set to the public https URL of the API.
 *
 *   docker compose run --rm tools npx tsx apps/api/scripts/update-agent-endpoints.ts            # dry run (default)
 *   docker compose run --rm tools npx tsx apps/api/scripts/update-agent-endpoints.ts --apply    # sends the operator txs
 *
 * Needs DATABASE_URL, SEPOLIA_RPC_URL and API_PUBLIC_URL (the dry run only reads). --apply also needs
 * OPERATOR_PRIVATE_KEY (the operator wallet, never the owner wallet) and gas. Resumable: agents whose record already
 * matches are skipped, so it is safe to re-run. Prints agent names, record values and tx hashes only.
 */
import { agents, createDb, users } from "@nanite/db";
import { agentEndpointUrl, createEnsServiceFromConfig, loadEnsConfig } from "@nanite/ens";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";

const apply = process.argv.includes("--apply");

async function main() {
  const apiPublicUrl = process.env.API_PUBLIC_URL?.trim();
  if (!apiPublicUrl) throw new Error("API_PUBLIC_URL is required (the public https URL of the API, no path)");
  if (apply && !/^https:\/\//.test(apiPublicUrl) && !process.argv.includes("--allow-insecure")) {
    throw new Error("refusing to write a non-https endpoint to ENS (pass --allow-insecure only for a test network)");
  }
  const want = agentEndpointUrl(apiPublicUrl);
  const config = loadEnsConfig({
    ...process.env,
    OPERATOR_PRIVATE_KEY: process.env.OPERATOR_PRIVATE_KEY ?? `0x${"11".repeat(32)}`,
  });
  if (apply && !process.env.OPERATOR_PRIVATE_KEY) throw new Error("OPERATOR_PRIVATE_KEY is required with --apply");
  const ens = createEnsServiceFromConfig(config);

  const handle = createDb(process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite", { max: 1 });
  try {
    const rows = await handle.db
      .select({ name: agents.name, ensName: agents.ensName, username: users.username })
      .from(agents)
      .innerJoin(users, eq(users.id, agents.userId))
      .where(and(isNotNull(agents.resolverAddress), isNull(agents.revokedAt)))
      .orderBy(asc(agents.ensName));
    console.log(`${apply ? "APPLY" : "DRY RUN"}: target agent-endpoint[mcp] = ${want}; ${rows.length} active agent(s)`);
    let changed = 0;
    let failed = 0;
    for (const a of rows) {
      try {
        const current = await ens.readAgentEndpoint(a.ensName);
        if (current === want) {
          console.log(`ok       ${a.ensName}`);
          continue;
        }
        changed += 1;
        if (!apply) {
          console.log(`WOULD SET ${a.ensName}: ${current ?? "(empty)"} -> ${want}`);
          continue;
        }
        const r = await ens.publishAgentEndpoint({ username: a.username, agentLabel: a.name, url: want });
        console.log(`set      ${a.ensName}: ${current ?? "(empty)"} -> ${want} ${Object.values(r.txHashes).join(",")}`);
      } catch (e) {
        failed += 1;
        console.log(`FAILED   ${a.ensName}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
      }
    }
    console.log(`${apply ? "updated" : "would update"} ${changed}, failed ${failed}`);
    if (failed) process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
