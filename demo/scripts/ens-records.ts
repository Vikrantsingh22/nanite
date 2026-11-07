/*
 * Prints an agent's public ENS records from Sepolia. Read-only: no keys, no .env, nothing is written.
 *
 *   docker compose run --rm -w /app/apps/api tools npx tsx ../../demo/scripts/ens-records.ts support.vikrantsingh.nanitecom.eth
 *
 * RPC: SEPOLIA_RPC_URL if set, else a public Sepolia endpoint. Exits 2 without a name, 1 if the address lookup fails.
 */
import { createPublicClient, http, BaseError } from "viem";
import { sepolia } from "viem/chains";

const name = process.argv[2];
if (!name) {
  console.error("usage: ens-records.ts <name>   e.g. support.vikrantsingh.nanitecom.eth");
  process.exit(2);
}

const universalResolverAddress = "0x24e1d8e068620b647ca097f961a61055f4f42d72"; // UniversalResolverV2 (Sepolia)
const client = createPublicClient({
  chain: sepolia,
  transport: http(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"),
  cacheTime: 0,
});

const keys = ["email", "nanite.send", "nanite.send-allow", "nanite.send-limit", "nanite.signer", "nanite.otp-ttl",
  "nanite.mail-ttl", "nanite.extend", "nanite.extend-limit", "agent-context", "agent-endpoint[mcp]"];
const unset = "(not set, default applies)";
const row = (k: string, v: string) => console.log(`  ${k.padEnd(20)}${v}`);
const msg = (e: unknown) => `error: ${e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e)}`;

console.log(name);
let failed = false;
try {
  row("addr", (await client.getEnsAddress({ name, universalResolverAddress })) ?? unset);
} catch (e) {
  row("addr", msg(e));
  failed = true;
}
for (const key of keys) {
  try {
    row(key, (await client.getEnsText({ name, key, universalResolverAddress })) || unset);
  } catch (e) {
    row(key, msg(e));
  }
}
process.exit(failed ? 1 : 0);
