// U4b: arkiv_query latency on the public (keyless) Rabdi RPC: N sequential identical queries. Read-only.
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/u4-query-latency.ts [samples]
import { P, query } from "./lib";

const N = Number(process.argv[2] ?? 15);
const ms: number[] = [];
const codes: number[] = [];
console.log(`# arkiv_query latency ${new Date().toISOString()} samples=${N}`);
for (let i = 0; i < N; i++) {
  const r = await query(`${P} AND agentId = str('alex.vikrant.nanitecom.eth')`);
  ms.push(r.ms);
  codes.push(r.http);
}
const sorted = [...ms].sort((a, b) => a - b);
console.log(`http: ${codes.join(",")}`);
console.log(`ms: ${ms.join(", ")}`);
console.log(`min=${sorted[0]} median=${sorted[Math.floor(N / 2)]} max=${sorted[N - 1]}`);
