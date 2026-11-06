// U3: variables / arithmetic / functions in queries (e.g. now - 3600, $expiresAt arithmetic). Read-only.
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/u3-expressions.ts
import { P, rpc, runCases } from "./lib";

const bt = await rpc("arkiv_getBlockTiming", []);
const block = parseInt(bt.body?.result?.current_block ?? bt.body?.result?.currentBlock ?? "0", 10) || 0;
console.log(`arkiv_getBlockTiming -> http ${bt.http}, ${JSON.stringify(bt.body)}`);

await runCases("U3 variables, arithmetic, functions", [
  { label: "baseline literal comparison", q: `${P} AND receivedAt > u64(1000000000)` },
  { label: "arithmetic on the right-hand side", q: `${P} AND receivedAt > u64(1793900000) - u64(3600)` },
  { label: "arithmetic with bare numbers", q: `${P} AND receivedAt > 1793900000 - 3600` },
  { label: "arithmetic on the attribute side", q: `${P} AND receivedAt + 3600 > u64(1793900000)` },
  { label: "now() function", q: `${P} AND receivedAt > now()` },
  { label: "$now variable", q: `${P} AND receivedAt > $now` },
  { label: "$blockNumber variable", q: `${P} AND $expiresAt > $blockNumber` },
  { label: "$expiresAt - literal arithmetic", q: `${P} AND $expiresAt - u64(1000) > u64(0)` },
  { label: "$expiresAt compared with a literal (works)", q: `${P} AND $expiresAt > u64(${block})` },
  { label: "$createdAt filter (documented as result-only)", q: `${P} AND $createdAt > u64(0)` },
  { label: "attribute = attribute (compare two columns)", q: `${P} AND agentId = threadId` },
]);
