// Summary of the live Nanite entities on Rabdi (read-only): counts per type, owners, creators, expiry spread.
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/list-live.ts
import { OPERATOR, P, rpc } from "./lib";

const h = (v: string) => parseInt(v, 16);
const r = await rpc("arkiv_query", [`${P} ORDER BY receivedAt:u64 DESC`, { select: { key: true, owner: true, creator: true, expiresAt: true, count: true, attributes: { agentId: true, type: true, receivedAt: true } }, limit: "0x64" }]);
const rows = r.body.result.data as any[];
const attr = (e: any, n: string) => e.attributes.find((a: any) => a.name === n)?.value;
const byType: Record<string, number> = {};
const owners = new Set<string>();
const agents = new Set<string>();
let minExp = Infinity;
let maxExp = 0;
for (const e of rows) {
  byType[attr(e, "type")] = (byType[attr(e, "type")] ?? 0) + 1;
  owners.add(e.owner.toLowerCase());
  agents.add(attr(e, "agentId"));
  minExp = Math.min(minExp, h(e.expiresAt));
  maxExp = Math.max(maxExp, h(e.expiresAt));
}
const block = h(r.body.result.blockNumber);
console.log(`# live entities ${new Date().toISOString()} operator=${OPERATOR}`);
console.log(`block ${block}, matches ${h(r.body.result.count)}, rows ${rows.length}`);
console.log(`by type: ${JSON.stringify(byType)}`);
console.log(`distinct owners: ${owners.size}, distinct agentIds: ${agents.size}, creators: ${[...new Set(rows.map((e) => e.creator.toLowerCase()))].join(",")}`);
console.log(`expiresAt blocks: min ${minExp} (${((minExp - block) * 2 / 86400).toFixed(1)} days left), max ${maxExp} (${((maxExp - block) * 2 / 86400).toFixed(1)} days left)`);
