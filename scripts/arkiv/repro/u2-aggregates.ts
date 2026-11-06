// U2: aggregates (COUNT / SUM / GROUP BY). Read-only. Shows what IS available: a total `count` on arkiv_query.
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/u2-aggregates.ts
import { P, rpc, runCases } from "./lib";

await runCases("U2 aggregates", [
  { label: "total count via select.count (supported)", q: `${P}`, opts: { select: { count: true }, limit: "0x1" } },
  { label: "count with a filter (supported)", q: `${P} AND type = str('conversation')`, opts: { select: { count: true }, limit: "0x1" } },
  { label: "COUNT(*) in the query", q: `COUNT(*) WHERE ${P}` },
  { label: "SELECT COUNT(*) form", q: `SELECT COUNT(*) FROM entities WHERE ${P}` },
  { label: "GROUP BY", q: `${P} GROUP BY type` },
  { label: "SUM()", q: `SUM(receivedAt) WHERE ${P}` },
  { label: "DISTINCT", q: `${P} DISTINCT agentId` },
]);

// Other possible aggregate-ish RPC methods.
for (const m of ["arkiv_count", "arkiv_aggregate"]) {
  const r = await rpc(m, [P]);
  console.log(`\n## method ${m}\nresult: http=${r.http} ${r.ms}ms ${JSON.stringify(r.body).slice(0, 200)}`);
}
