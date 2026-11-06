// W4: schema + query patterns, poisoning, latency. Usage: tsx scripts/arkiv/w4-queries.ts <stage|all>
// stages: balance | seed | queries | poison | latency | leak
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { and, asc, between, desc, eq, gt } from "@arkiv-network/sdk/query";
import { ExpirationTime } from "@arkiv-network/sdk";
import { addr, bytes, defineSchema, key, str, u64 } from "@arkiv-network/sdk/schema";
import type { Hex } from "viem";
import { EmailSchema } from "./schema";
import { account, publicClient, recordFinding, sleep, walletFor } from "./lib";

const W = "W4";
const WRITER = account(5).address;
const ATTACKER = account(6).address;
const USER = "0x1111111111111111111111111111111111111111" as const; // fake Nanite user
const ALEX = "alex.t03.nanitecom.eth";
const BOB = "bob.t03.nanitecom.eth";
const SCHEMA = "nanite.email.v0";
const TEST_SECRET = "w4-test-secret-not-real";
const hmac = (s: string) => createHmac("sha256", TEST_SECRET).update(s.toLowerCase()).digest("hex");
const pc = publicClient();
const stage = process.argv[2] ?? "all";
const RES = "docs/arkiv-spike/results/W4.json";

async function retry<T>(label: string, fn: () => Promise<T>, n = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= n || (e as Error).name === "QueryError") throw e;
      console.log(`  retry ${label} (${(e as Error).message.slice(0, 80)})`);
      await sleep(2000 * (i + 1));
    }
  }
}
const paced = async (label: string, fn: () => Promise<any>): Promise<any> => {
  await sleep(600);
  return retry(label, fn);
};
const log = (m: string, o?: unknown) => console.log(m, o === undefined ? "" : JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

type Seed = { key: Hex; agentId: string; type: string; receivedAt: number; threadId: string; sender: string };
function seedState(): { seeds: Seed[]; base: number; txHash: string } {
  const arr = JSON.parse(readFileSync(RES, "utf8")) as any[];
  const f = [...arr].reverse().find((x) => x.test === "seed");
  if (!f) throw new Error("run seed first");
  return f;
}
const ids = (rows: { $key: Hex }[]) => rows.map((r) => r.$key);
const sel = { $key: true, agentId: true, type: true, receivedAt: true, threadId: true, senderHash: true, $creator: true } as const;
const base = () => pc.select(sel as any).from(EmailSchema as any) as any;
const same = (a: Hex[], b: Hex[]) => JSON.stringify(a) === JSON.stringify(b);
const sameSet = (a: Hex[], b: Hex[]) => same([...a].sort(), [...b].sort());

function mkValues(s: { agentId: string; type: string; receivedAt: number; threadId: string; sender: string }) {
  return {
    agentId: s.agentId, ownerId: addr(USER), type: s.type, receivedAt: u64(BigInt(s.receivedAt)),
    threadId: s.threadId, senderHash: hmac(s.sender), keyId: "k1",
    ciphertext: new Uint8Array(randomBytes(64)), wrappedKeys: new Uint8Array(randomBytes(80)), nonce: new Uint8Array(randomBytes(24)),
  };
}

async function balance() {
  const b5 = await pc.getBalance({ address: WRITER });
  const b6 = await pc.getBalance({ address: ATTACKER });
  log("balances", { writer: b5, attacker: b6 });
  return b5;
}

async function seed() {
  const t0 = Math.floor(Date.now() / 1000) - 7200; // spread over the last 2h, 10 min apart
  const defs: Omit<Seed, "key">[] = [];
  const senders = ["a@example.com", "b@example.com", "c@bank.test", "noreply@svc.test"];
  for (let i = 0; i < 8; i++)
    defs.push({ agentId: ALEX, type: i % 2 === 0 ? "otp" : "conversation", receivedAt: t0 + i * 600,
      threadId: i % 2 === 0 ? `otp-${i}` : i < 5 ? "thr-A" : "thr-B", sender: senders[i % 4] });
  for (let i = 0; i < 4; i++)
    defs.push({ agentId: BOB, type: i % 2 ? "otp" : "conversation", receivedAt: t0 + i * 900 + 300, threadId: i % 2 ? `otp-b${i}` : "thr-A", sender: senders[(i + 1) % 4] });
  const w = walletFor(5);
  const r = await retry("seed", () => w.executeBatch({
    creates: defs.map((d) => ({ schema: EmailSchema, values: mkValues(d) as any, expiration: ExpirationTime.fromHours(1) })),
  } as any));
  log("seed tx", { txHash: r.txHash, n: r.createdEntities.length });
  const seeds: Seed[] = defs.map((d, i) => ({ ...d, key: r.createdEntities[i] }));
  recordFinding(W, { test: "seed", txHash: r.txHash, base: t0, seeds, note: "12 emails, 1 executeBatch, expiry 1h, writer idx5" });
}

async function queries() {
  const { seeds } = seedState();
  const alex = seeds.filter((s) => s.agentId === ALEX).sort((a, b) => b.receivedAt - a.receivedAt);
  const out: any[] = [];
  const check = async (name: string, builder: any, expected: Hex[], ordered: boolean, rawOpts?: { raw: string; opts: any }) => {
    const t = Date.now();
    const res = await paced(name, () => builder.fetch());
    const got = ids(res.entities);
    const ok = ordered ? same(got, expected) : sameSet(got, expected);
    const entry: any = { name, builderQuery: builder.toString(), rows: got.length, ok, ms: Date.now() - t, count: res.count?.toString() };
    if (rawOpts) {
      const t2 = Date.now();
      const rr = await paced(name + " raw", () => (pc as any).query(rawOpts.raw, { select: { $key: true }, ...rawOpts.opts }));
      const rg = rr.entities.map((e: any) => e.$key);
      entry.rawQuery = rawOpts.raw; entry.rawOpts = rawOpts.opts && JSON.parse(JSON.stringify(rawOpts.opts, (k, v) => typeof v === "object" && v?.dir ? String(v.dir) + ":" + v.name : v));
      entry.rawOk = ordered ? same(rg, expected) : sameSet(rg, expected);
      entry.rawMs = Date.now() - t2;
      entry.rawCount = rr.count?.toString();
    }
    log(name, entry);
    out.push(entry);
    return res;
  };
  const pin = `$creator = addr(${WRITER})`;
  const sch = `arkiv.schema = str('${SCHEMA}')`;
  const A = `agentId = str('${ALEX}')`;
  // (a) inbox pages
  await check("a1 inbox page1 (offset 0)", base().createdBy(WRITER).where(eq("agentId", ALEX)).orderBy(desc("receivedAt")).limit(5),
    alex.slice(0, 5).map((s) => s.key), true,
    { raw: `${sch} AND ${pin} AND ${A}`, opts: { orderBy: desc("receivedAt", "u64"), limit: 5 } });
  await check("a2 inbox page2 (offset 5)", base().createdBy(WRITER).where(eq("agentId", ALEX)).orderBy(desc("receivedAt")).limit(5).offset(5),
    alex.slice(5, 10).map((s) => s.key), true,
    { raw: `${sch} AND ${pin} AND ${A}`, opts: { orderBy: desc("receivedAt", "u64"), limit: 5, offset: 5 } });
  // $key cursor pattern: asc($key), gt($key, last)
  const byKey = alex.map((s) => s.key).sort();
  const p1 = await check("a3 cursor page1 ($key asc)", base().createdBy(WRITER).where(eq("agentId", ALEX)).orderBy(asc("$key")).limit(5), byKey.slice(0, 5), true,
    { raw: `${sch} AND ${pin} AND ${A}`, opts: { orderBy: asc("$key"), limit: 5 } });
  const last = p1.entities[p1.entities.length - 1].$key;
  await check("a4 cursor page2 ($key > last)", base().createdBy(WRITER).where(eq("agentId", ALEX), gt("$key", key(last as Hex))).orderBy(asc("$key")).limit(5), byKey.slice(5, 10), true,
    { raw: `${sch} AND ${pin} AND ${A} AND $key > key(${last})`, opts: { orderBy: asc("$key"), limit: 5 } });
  // (b) otp only
  const otps = alex.filter((s) => s.type === "otp");
  await check("b otp only", base().createdBy(WRITER).where(eq("agentId", ALEX), eq("type", "otp")).orderBy(desc("receivedAt")),
    otps.map((s) => s.key), true,
    { raw: `${sch} AND ${pin} AND ${A} AND type = str('otp')`, opts: { orderBy: desc("receivedAt", "u64") } });
  // (c) latest otp
  await check("c latest otp", base().createdBy(WRITER).where(eq("agentId", ALEX), eq("type", "otp")).orderBy(desc("receivedAt")).limit(1),
    [otps[0].key], true,
    { raw: `${sch} AND ${pin} AND ${A} AND type = str('otp')`, opts: { orderBy: desc("receivedAt", "u64"), limit: 1 } });
  // (d) between
  const lo = alex[5].receivedAt, hi = alex[2].receivedAt;
  const inRange = alex.filter((s) => s.receivedAt >= lo && s.receivedAt <= hi);
  await check("d receivedAt BETWEEN", base().createdBy(WRITER).where(eq("agentId", ALEX), between("receivedAt", u64(BigInt(lo)), u64(BigInt(hi)))).orderBy(desc("receivedAt")),
    inRange.map((s) => s.key), true,
    { raw: `${sch} AND ${pin} AND ${A} AND receivedAt >= u64(${lo}) AND receivedAt <= u64(${hi})`, opts: { orderBy: desc("receivedAt", "u64") } });
  // (e) thread
  const thr = alex.filter((s) => s.threadId === "thr-A").sort((a, b) => a.receivedAt - b.receivedAt);
  await check("e thread thr-A (asc)", base().createdBy(WRITER).where(eq("agentId", ALEX), eq("threadId", "thr-A")).orderBy(asc("receivedAt")),
    thr.map((s) => s.key), true,
    { raw: `${sch} AND ${pin} AND ${A} AND threadId = str('thr-A')`, opts: { orderBy: asc("receivedAt", "u64") } });
  // (f) sender blind index, across agents
  const sh = hmac("a@example.com");
  const bySender = seeds.filter((s) => s.sender === "a@example.com").sort((a, b) => b.receivedAt - a.receivedAt);
  await check("f senderHash lookup (both agents)", base().createdBy(WRITER).where(eq("senderHash", sh)).orderBy(desc("receivedAt")),
    bySender.map((s) => s.key), true,
    { raw: `${sch} AND ${pin} AND senderHash = str('${sh}')`, opts: { orderBy: desc("receivedAt", "u64") } });
  // (g) count
  const cnt = await paced("g count", () => pc.select({ $key: true } as any).from(EmailSchema as any).createdBy(WRITER).where(eq("agentId", ALEX)).limit(1).withCount().fetch() as any);
  const cnt2 = await paced("g count()", () => (pc as any).count().from(EmailSchema).createdBy(WRITER).where(eq("agentId", ALEX)).fetch());
  const cnt3 = await paced("g raw count", () => (pc as any).query(`${sch} AND ${pin} AND ${A}`, { select: { $key: true }, limit: 1, count: true }));
  const g = { name: "g count", withCount: cnt.count?.toString(), countBuilder: String(cnt2), rawCount: cnt3.count?.toString(), expected: alex.length,
    ok: Number(cnt.count) === alex.length && Number(cnt2) === alex.length && Number(cnt3.count) === alex.length };
  log("g", g); out.push(g);
  // dump one raw row attribute shape (shows arkiv.schema tag etc.), no secrets
  const sample = await paced("sample", () => (pc as any).query(`${sch} AND ${pin} AND ${A}`, { limit: 1, select: { $key: true, $attributes: true, $creator: true, $owner: true } }));
  const attrShape = JSON.parse(JSON.stringify(sample.entities[0], (k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? `<bytes ${v.length}>` : v)));
  log("sample row", attrShape);
  recordFinding(W, { test: "queries", results: out, allOk: out.every((o) => o.ok !== false && o.rawOk !== false), sampleRow: attrShape });
}

async function poison() {
  const { seeds } = seedState();
  const wa = walletFor(6);
  const fakes = [0, 1].map((i) => ({ agentId: ALEX, type: "otp", receivedAt: Math.floor(Date.now() / 1000) + i, threadId: "otp-fake", sender: "evil@attacker.test" }));
  const r = await retry("poison", () => wa.executeBatch({
    creates: fakes.map((d) => ({ schema: EmailSchema, values: { ...mkValues(d), ciphertext: new Uint8Array(Buffer.from("FAKE: your code is 000000")) } as any, expiration: ExpirationTime.fromHours(1) })),
  } as any));
  log("attacker tx", { txHash: r.txHash, keys: r.createdEntities });
  // wait for visibility
  const q = (b: any) => b.where(eq("agentId", ALEX), eq("type", "otp")).orderBy(desc("receivedAt")).limit(5);
  let naive: any;
  for (let i = 0; i < 20; i++) {
    naive = await paced("naive", () => q(base()).fetch());
    if (ids(naive.entities).includes(r.createdEntities[0])) break;
    await sleep(2000);
  }
  const naiveRows = naive.entities.map((e: any) => ({ key: e.$key, creator: e.$creator, agentId: e.agentId }));
  const pinned = await paced("pinned", () => q(base().createdBy(WRITER)).fetch());
  const pinnedOwner = await paced("pinned owner", () => q(base().ownedBy(WRITER)).fetch());
  const latestNaive = await paced("latest naive", () => base().where(eq("agentId", ALEX), eq("type", "otp")).orderBy(desc("receivedAt")).limit(1).fetch());
  const rawNaive = `${sch()} AND agentId = str('${ALEX}') AND type = str('otp')`;
  const attackerSeen = naive.entities.filter((e: any) => String(e.$creator).toLowerCase() === ATTACKER.toLowerCase()).length;
  const pinnedAttacker = pinned.entities.filter((e: any) => String(e.$creator).toLowerCase() === ATTACKER.toLowerCase()).length;
  const pinnedOwnerAttacker = pinnedOwner.entities.filter((e: any) => String(e.$creator).toLowerCase() === ATTACKER.toLowerCase()).length;
  // look-alike skip: attacker writes an entity with the same schema tag but WRONG column types/missing columns, via raw schema-less create
  let lookalike: any = { note: "see below" };
  try {
    const bad = await retry("lookalike", () => wa.createEntity(
      // different schema object with the same name but fewer columns
      defineSchema(SCHEMA, { agentId: str().indexed() }) as any,
      { agentId: ALEX } as any, { expiration: ExpirationTime.fromHours(1) }));
    let res: any;
    for (let i = 0; i < 15; i++) {
      res = await paced("lookalike q", () => base().where(eq("agentId", ALEX)).limit(50).fetch());
      if (res.skipped?.length || res.entities.some((e: any) => e.$key === bad.entityKey)) break;
      await sleep(2000);
    }
    const rawAll = await paced("lookalike raw", () => (pc as any).query(rawNaive.replace(/ AND type.*/, ""), { select: { $key: true }, limit: 50 }));
    lookalike = { badKey: bad.entityKey, tx: bad.txHash, builderEntities: res.entities.length, skipped: res.skipped?.length ?? 0, skippedSample: JSON.parse(JSON.stringify(res.skipped?.slice(0, 2) ?? [], (k, v) => (typeof v === "bigint" ? v.toString() : v))), badInBuilder: res.entities.some((e: any) => e.$key === bad.entityKey), badInRaw: rawAll.entities.some((e: any) => e.$key === bad.entityKey) };
  } catch (e) {
    lookalike = { error: (e as Error).message.slice(0, 300) };
  }
  const out = { test: "poison", attackerTx: r.txHash, attackerKeys: r.createdEntities, legitOtpKeys: seeds.filter((s) => s.agentId === ALEX && s.type === "otp").map((s) => s.key),
    naiveQuery: q(base()).toString(), naiveRows, attackerRowsInNaive: attackerSeen,
    naiveLatestOtpCreator: latestNaive.entities[0]?.$creator, pinnedQuery: q(base().createdBy(WRITER)).toString(), pinnedRows: pinned.entities.length, attackerRowsInPinnedCreator: pinnedAttacker,
    pinnedOwnerQuery: q(base().ownedBy(WRITER)).toString(), attackerRowsInPinnedOwner: pinnedOwnerAttacker, lookalike };
  log("poison", out);
  recordFinding(W, out);
  function sch() { return `arkiv.schema = str('${SCHEMA}')`; }
}

async function latency() {
  const w = walletFor(5);
  const runs: any[] = [];
  for (let i = 0; i < 3; i++) {
    const d = { agentId: BOB, type: "otp", receivedAt: Math.floor(Date.now() / 1000), threadId: `lat-${i}-${Date.now()}`, sender: "lat@example.com" };
    const r = await retry("lat create", () => w.createEntity(EmailSchema as any, mkValues(d) as any, { expiration: ExpirationTime.fromMinutes(5) }));
    const tReceipt = Date.now(); // createEntity already waited for receipt
    let tGet = 0, tQuery = 0;
    const q = () => pc.select({ $key: true } as any).from(EmailSchema as any).createdBy(WRITER).where(eq("threadId", d.threadId)).fetch() as any;
    const getP = (async () => { for (;;) { try { await pc.getEntity(r.entityKey); tGet = Date.now() - tReceipt; return; } catch { await sleep(250); } } })();
    const qP = (async () => { for (;;) { try { const x = await q(); if (x.entities.length) { tQuery = Date.now() - tReceipt; return; } } catch {} await sleep(250); } })();
    await Promise.race([Promise.all([getP, qP]), sleep(60_000)]);
    runs.push({ run: i, tx: r.txHash, key: r.entityKey, getEntityMs: tGet, queryMs: tQuery });
    log("lat", runs[i]);
    await sleep(1000);
  }
  // watchEntityEvents
  const notes: any[] = [];
  const evs: { ms: number; key: string }[] = [];
  let tReceiptW = 0;
  const unwatch = (pc as any).watchEntityEvents({
    pollingInterval: 500,
    onEntityCreated: (e: any) => { if (String(e.owner).toLowerCase() === WRITER.toLowerCase()) evs.push({ ms: Date.now(), key: e.entityKey }); },
    onError: (e: any) => notes.push(String(e?.message ?? e).slice(0, 100)),
  });
  await sleep(3000);
  const watchRuns: any[] = [];
  for (let i = 0; i < 2; i++) {
    const d = { agentId: BOB, type: "otp", receivedAt: Math.floor(Date.now() / 1000), threadId: `watch-${i}`, sender: "lat@example.com" };
    const r = await retry("watch create", () => w.createEntity(EmailSchema as any, mkValues(d) as any, { expiration: ExpirationTime.fromMinutes(5) }));
    tReceiptW = Date.now();
    for (let j = 0; j < 60 && !evs.find((x) => x.key === r.entityKey); j++) await sleep(250);
    const ev = evs.find((x) => x.key === r.entityKey);
    watchRuns.push({ key: r.entityKey, tx: r.txHash, notifyMsAfterReceipt: ev ? ev.ms - tReceiptW : null });
    log("watch", watchRuns[i]);
  }
  unwatch();
  recordFinding(W, { test: "latency", runs, watchRuns, watchErrors: notes, note: "ms measured from createEntity return (receipt received) to first success" });
}

if (stage === "balance") await balance();
else if (stage === "seed") await seed();
else if (stage === "queries") await queries();
else if (stage === "poison") await poison();
else if (stage === "lookalike") {
  const r = await paced("la", () => base().where(eq("agentId", ALEX)).createdBy(ATTACKER).limit(50).fetch());
  const rt = await paced("la throw", () => (pc.select(sel as any).from(EmailSchema as any, { onMismatch: "throw" } as any) as any).where(eq("agentId", ALEX)).createdBy(ATTACKER).limit(50).fetch().then(() => "no error", (e: Error) => e.name + ": " + e.message.slice(0, 200)));
  const raw = await paced("la raw", () => (pc as any).query(`agentId = str('${ALEX}') AND $creator = addr(${ATTACKER})`, { select: { $key: true, $attributes: true }, limit: 50 }));
  const o = { test: "lookalike", builderEntities: r.entities.length, skippedType: typeof r.skipped, skipped: r.skipped, throwMode: rt, rawNoSchemaTag: raw.entities.map((e: any) => ({ k: e.$key, attrs: Object.keys(e.$attributes) })) };
  log("lookalike", o); recordFinding(W, o);
} else if (stage === "latency") await latency();
else if (stage === "all") { await seed(); await sleep(8000); await queries(); await poison(); await latency(); }
else if (stage === "wait") {
  for (let i = 0; i < 60; i++) { const b = await balance(); if (b > 0n) process.exit(0); await sleep(30_000); }
  process.exit(2);
}
void and; void bytes; void existsSync;
