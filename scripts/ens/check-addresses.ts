// Read-only: compares config/sepolia.json to the deployment artifacts' addresses and checks code exists on Sepolia.
import { readFileSync } from "node:fs";
import { createPublicClient, http, getAddress } from "viem";
import { sepolia } from "viem/chains";
const cfg = JSON.parse(readFileSync(new URL("../../config/sepolia.json", import.meta.url), "utf8"));
const md = readFileSync(process.argv[2] ?? "/dev/stdin", "utf8");
const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
for (const [name, addr] of Object.entries<string>(cfg.contracts)) {
  const m = md.match(new RegExp(`\\| ${name} \\| \\[(0x[0-9a-fA-F]{40})\\]`));
  const art = m ? getAddress(m[1]) : null;
  const code = await client.getCode({ address: addr as `0x${string}` });
  console.log(`${name.padEnd(26)} artifact=${art === getAddress(addr) ? "MATCH" : "MISMATCH " + art} code=${code && code !== "0x" ? `yes (${(code.length - 2) / 2}B)` : "NO CODE !!!"}`);
}
