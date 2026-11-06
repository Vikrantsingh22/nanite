// After an entity expires: is it gone from queries, and is its data still readable in the creating tx? Read-only.
// Entity 0x554e99f0...7773 was created by the W2 spike with a 60 s lifetime (docs/arkiv-spike/results/W2.json, t1-create).
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/expiry-history.ts
import { rpc } from "./lib";

const key = "0x554e99f07de021917a0140248d33fc3f6421b85820ccca6d4fc9a72e5e517773";
const tx = "0xaab250bc20b64acfa15715ffad21fa8d02200ad7575e74934df158079c42f38c";
const oog = "0xfc55edb8db994ce031508d6310cba967f405d5705d55557154e46e3962de2064"; // W2 "ran out of gas" tx
console.log(`# expiry and history ${new Date().toISOString()}`);

const e = await rpc("arkiv_getEntity", [key]);
console.log(`arkiv_getEntity(${key.slice(0, 12)}...) -> http ${e.http} ${JSON.stringify(e.body).slice(0, 160)}`);
const q = await rpc("arkiv_query", [`$key = key(${key})`, { select: { key: true }, limit: "0x1" }]);
console.log(`arkiv_query($key = key(...)) -> ${JSON.stringify(q.body.result ?? q.body.error).slice(0, 160)}`);
const t = await rpc("eth_getTransactionByHash", [tx]);
const input: string = t.body.result?.input ?? "";
console.log(`eth_getTransactionByHash(${tx.slice(0, 12)}...) -> from ${t.body.result?.from}, block ${t.body.result?.blockNumber}, input bytes = ${(input.length - 2) / 2}`);
const r = await rpc("eth_getTransactionReceipt", [oog]);
console.log(`W2 out-of-gas tx ${oog.slice(0, 12)}...: status=${r.body.result?.status}, gasUsed=${parseInt(r.body.result?.gasUsed ?? "0", 16)}`);
const gp = await rpc("eth_gasPrice", []);
console.log(`eth_gasPrice -> ${gp.body.result} (${parseInt(gp.body.result, 16)} wei)`);
