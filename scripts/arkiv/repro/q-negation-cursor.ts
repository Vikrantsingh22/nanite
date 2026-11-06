// Negation (NOT / ne) and the RPC `cursor` field, versus what SDK 1.0.1 exposes. Read-only.
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/q-negation-cursor.ts
import * as q from "@arkiv-network/sdk/query";
import { P, query, rpc, runCases, summarize } from "./lib";

console.log(`SDK query exports: ${Object.keys(q).sort().join(", ")}`);
console.log(`has ne: ${"ne" in q}, has not: ${"not" in q}, has startsWith: ${"startsWith" in q}`);

await runCases("Negation forms", [
  { label: "NOT (attr = value) with parentheses (the form the node's error message suggests)", q: `${P} AND NOT (agentId = str('zzz'))` },
  { label: "NOT (type = otp)", q: `${P} AND NOT (type = str('otp'))` },
  { label: "type = otp, for comparison", q: `${P} AND type = str('otp')` },
]);

// Cursor: does the raw node return and accept one?
console.log("\n# cursor over the raw RPC");
const first = await query(P, { limit: "0x2", select: { key: true } });
console.log(`page 1: ${summarize(first)}`);
const cursor = first.body?.result?.cursor;
console.log(`page 1 cursor field: ${JSON.stringify(cursor)}`);
if (cursor) {
  const second = await rpc("arkiv_query", [P, { select: { key: true }, limit: "0x2", cursor }]);
  console.log(`page 2 with {cursor}: ${summarize(second)} keys=${JSON.stringify(second.body?.result?.data?.map((d: any) => d.key.slice(0, 12)))}`);
  console.log(`page 1 keys=${JSON.stringify(first.body.result.data.map((d: any) => d.key.slice(0, 12)))}`);
  const third = await rpc("arkiv_query", [P, { select: { key: true }, limit: "0x2", cursor, offset: "0x2" }]);
  console.log(`cursor + offset together: ${summarize(third)}`);
}
