// W2: expiry and retention spike. Usage: tsx scripts/arkiv/w2-expiry.ts [wait|t1|t2|t3|t4|t5|t6|all]
// Wallet index 2 (W2) + index 7 ("stranger"). Never prints keys.
import { ExpirationTime } from "@arkiv-network/sdk";
import { eq } from "@arkiv-network/sdk/query";
import { formatEther, parseEther, type Hex } from "viem";
import { addr, u64, str, bytes } from "@arkiv-network/sdk/schema";
import { EmailSchema } from "./schema";
import { account, publicClient, recordFinding, sleep, txUrl, walletFor, RPC_URL, EXPLORER } from "./lib";

const W = "W2";
const me = account(2);
const stranger = account(7);
const wc = walletFor(2);
const sc = walletFor(7);
const pc = publicClient();
const MAX_LIFETIME = 7_884_000;
const rec = (o: Record<string, unknown>) => { recordFinding(W, o); console.log(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v))); };
const errMsg = (e: unknown) => ((e as Error)?.message ?? String(e)).split("\n").slice(0, 3).join(" | ").slice(0, 400);

async function retry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const m = errMsg(e);
      if (i < tries && /ran out of gas/i.test(m)) { await sleep(2000); continue; }
      if (i < tries && /429|rate|timeout|timed out|fetch failed|HTTP request failed|ECONN|ETIMEDOUT/i.test(m) && !/revert|EntityMutation/i.test(m)) { await sleep(3000 * (i + 1)); continue; }
      throw e;
    }
  }
}
const balance = (a: Hex) => retry(() => pc.getBalance({ address: a }));
async function receiptInfo(hash: Hex) {
  const r = await retry(() => pc.getTransactionReceipt({ hash }));
  return { block: r.blockNumber, gasUsed: r.gasUsed, gasPrice: r.effectiveGasPrice, feeWei: r.gasUsed * r.effectiveGasPrice };
}
async function timing() { return retry(() => pc.getBlockTiming()); }

const base = (type: string) => ({
  agentId: str("w2-test"), ownerId: addr(me.address), type: str(type), receivedAt: u64(BigInt(Math.floor(Date.now() / 1000))),
  threadId: str("t"), senderHash: str("0".repeat(64)), keyId: str("k1"),
  ciphertext: bytes(new Uint8Array(200).fill(7)), wrappedKeys: bytes(new Uint8Array(80).fill(1)), nonce: bytes(new Uint8Array(24).fill(2)),
});
const mk = (type: string, expiration: any, flags?: { permissionlessExtension?: boolean }, w = wc) => retry(() => w.createEntity(EmailSchema, base(type) as any, { expiration, ...(flags ? { flags } : {}) } as any));
async function getExp(key: Hex) {
  try { const e: any = await retry(() => pc.getEntity(key)); return e.$expiresAt as bigint; } catch (e) { return `ERR:${(e as Error).name}`; }
}

async function wait() {
  const t0 = Date.now();
  while (Date.now() - t0 < 30 * 60_000) {
    const b = await balance(me.address);
    console.log(new Date().toISOString(), "balance", formatEther(b));
    if (b > 0n) return;
    await sleep(30_000);
  }
  console.log("STILL ZERO after 30 min"); process.exit(2);
}

async function fundStranger() {
  const b = await balance(stranger.address);
  if (b >= parseEther("0.01")) { console.log("stranger funded", formatEther(b)); return; }
  const h = await retry(() => wc.sendTransaction({ to: stranger.address, value: parseEther("0.05") } as any));
  await retry(() => pc.waitForTransactionReceipt({ hash: h }));
  rec({ test: "fund-stranger", tx: h });
}

async function t1() {
  const t = await timing();
  const b0 = await balance(me.address);
  const c = await mk("otp", ExpirationTime.fromSeconds(60));
  const ri = await receiptInfo(c.txHash);
  rec({ test: "t1-create", key: c.entityKey, tx: c.txHash, url: txUrl(c.txHash), createBlock: ri.block, expiresAtBlock: c.expiresAt, lifetimeBlocks: c.expiresAt - ri.block, feeWei: ri.feeWei, timingBefore: t, balanceBefore: b0 });
  const key = c.entityKey;
  let lastSeenBlock = 0n, firstGoneBlock: bigint | null = null, lastSeenAt = "", goneAt = "";
  const log: any[] = [];
  const start = Date.now();
  while (Date.now() - start < 240_000) {
    let blk: bigint | undefined; let qHas = false, gHas = false;
    try {
      const q: any = await retry(() => pc.select({ $key: true, $expiresAt: true }).from(EmailSchema).where(eq("type", "otp")).ownedBy(me.address).fetch());
      blk = q.blockNumber; qHas = q.entities.some((e: any) => e.$key === key);
    } catch (e) { log.push({ qerr: errMsg(e) }); }
    const ge = await getExp(key); gHas = typeof ge === "bigint";
    const now = new Date().toISOString();
    log.push({ now, blk, qHas, gHas });
    console.log(now, "blk", blk, "query", qHas, "getEntity", gHas);
    if (qHas || gHas) { lastSeenBlock = blk ?? lastSeenBlock; lastSeenAt = now; }
    if (!qHas && !gHas && blk !== undefined && blk >= c.expiresAt - 5n) { firstGoneBlock = blk; goneAt = now; break; }
    await sleep(10_000);
  }
  const t2 = await timing();
  rec({ test: "t1-expiry", key, expiresAtBlock: c.expiresAt, lastSeenBlock, lastSeenAt, firstGoneBlock, goneAt, timingAfter: t2, log });
  // extend after expiry
  try { await wc.extendEntity({ entityKey: key, expiration: ExpirationTime.fromMinutes(5) }); rec({ test: "t1-extend-after-expiry", result: "UNEXPECTED SUCCESS" }); }
  catch (e) { rec({ test: "t1-extend-after-expiry", result: "error", msg: errMsg(e) }); }
  try { await wc.patchEntity(EmailSchema, key, { set: { keyId: str("k2") } } as any); rec({ test: "t1-patch-after-expiry", result: "UNEXPECTED SUCCESS" }); }
  catch (e) { rec({ test: "t1-patch-after-expiry", result: "error", msg: errMsg(e) }); }
  // raw RPC / other visibility
  for (const [name, body] of [
    ["arkiv_getEntity", { method: "arkiv_getEntity", params: [key] }],
    ["eth_getTransactionByHash", { method: "eth_getTransactionByHash", params: [c.txHash] }],
  ] as const) {
    try {
      const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) });
      const txt = (await r.text()).slice(0, 300);
      rec({ test: "t1-raw-" + name, status: r.status, resp: txt });
    } catch (e) { rec({ test: "t1-raw-" + name, err: errMsg(e) }); }
  }
  for (const u of [`${EXPLORER}/entity/${key}`, `${EXPLORER}/tx/${c.txHash}`]) {
    try { const r = await fetch(u); const txt = await r.text(); rec({ test: "t1-explorer", url: u, status: r.status, len: txt.length, containsKey: txt.includes(key.slice(2, 12)) }); }
    catch (e) { rec({ test: "t1-explorer", url: u, err: errMsg(e) }); }
  }
}

async function t2() {
  const c = await mk("conversation", ExpirationTime.fromMinutes(2));
  const rc = await receiptInfo(c.txHash);
  const e0 = await getExp(c.entityKey);
  await sleep(20_000);
  const x = await retry(() => wc.extendEntity({ entityKey: c.entityKey, expiration: ExpirationTime.fromHours(1) }));
  const rx = await receiptInfo(x.txHash);
  const e1 = await getExp(c.entityKey);
  rec({ test: "t2-extend", key: c.entityKey, createTx: c.txHash, createBlock: rc.block, createExpiresAt: c.expiresAt, expiresAtBeforeExtend: e0, extendTx: x.txHash, extendBlock: rx.block, extendReturnedExpiresAt: x.expiresAt, expiresAtAfterRead: e1, deltaFromExtendBlock: x.expiresAt - rx.block, extendFeeWei: rx.feeWei, createFeeWei: rc.feeWei, expectedBlocks1h: 1800 });
  try {
    const r = await wc.extendEntity({ entityKey: c.entityKey, expiration: ExpirationTime.fromMinutes(10) });
    rec({ test: "t2-shorten", result: "SUCCESS (unexpected)", expiresAt: r.expiresAt });
  } catch (e) { rec({ test: "t2-shorten", result: "error", msg: errMsg(e) }); }
  rec({ test: "t2-after-shorten", expiresAt: await getExp(c.entityKey) });
}

async function t3() {
  const b0 = await balance(me.address);
  const c = await mk("conversation", ExpirationTime.max());
  const r = await receiptInfo(c.txHash);
  rec({ test: "t3-max", key: c.entityKey, tx: c.txHash, createBlock: r.block, expiresAt: c.expiresAt, lifetimeBlocks: c.expiresAt - r.block, maxLifetime: MAX_LIFETIME, feeWei: r.feeWei, balanceDeltaWei: b0 - (await balance(me.address)) });
  try { await mk("conversation", ExpirationTime.fromBlocks(MAX_LIFETIME + 1)); rec({ test: "t3-max+1", result: "SUCCESS (unexpected)" }); }
  catch (e) { rec({ test: "t3-max+1", result: "error", name: (e as Error).name, msg: errMsg(e) }); }
  // max extension on an existing entity (resets to max from now)
  const x = await retry(() => wc.extendEntity({ entityKey: c.entityKey, expiration: ExpirationTime.max() }));
  const rx = await receiptInfo(x.txHash);
  rec({ test: "t3-extend-max", tx: x.txHash, block: rx.block, expiresAt: x.expiresAt, delta: x.expiresAt - rx.block, feeWei: rx.feeWei });
  // raw node rejection: atBlock beyond max via SDK bypass attempt (SDK pre-check expected to reject)
  try { await retry(() => wc.extendEntity({ entityKey: c.entityKey, expiration: ExpirationTime.atBlock(x.expiresAt + 100n) })); rec({ test: "t3-atBlock-over", result: "SUCCESS (unexpected)" }); }
  catch (e) { rec({ test: "t3-atBlock-over", result: "error", name: (e as Error).name, msg: errMsg(e), note: "raw node-level rejection not tested (SDK pre-check)" }); }
}

async function t4() {
  await fundStranger();
  const yes = await mk("conversation", ExpirationTime.fromHours(1), { permissionlessExtension: true });
  const no = await mk("conversation", ExpirationTime.fromHours(1));
  const flagsYes = await retry(() => pc.getEntity(yes.entityKey)) as any;
  const flagsNo = await retry(() => pc.getEntity(no.entityKey)) as any;
  rec({ test: "t4-create", withFlag: yes.entityKey, withoutFlag: no.entityKey, flagsYes: flagsYes.$creationFlags, flagsNo: flagsNo.$creationFlags, expYes: yes.expiresAt, expNo: no.expiresAt });
  for (const [label, k] of [["withFlag", yes.entityKey], ["withoutFlag", no.entityKey]] as const) {
    try { const x = await retry(() => sc.extendEntity({ entityKey: k, expiration: ExpirationTime.fromHours(2) })); const rx = await receiptInfo(x.txHash); rec({ test: "t4-stranger-extend", label, result: "SUCCESS", tx: x.txHash, block: rx.block, newExpiresAt: x.expiresAt, owner: ((await retry(() => pc.getEntity(k))) as any).$owner }); }
    catch (e) { rec({ test: "t4-stranger-extend", label, result: "error", msg: errMsg(e) }); }
    try { await sc.patchEntity(EmailSchema, k, { set: { keyId: str("evil") } } as any); rec({ test: "t4-stranger-patch", label, result: "SUCCESS (BAD)" }); }
    catch (e) { rec({ test: "t4-stranger-patch", label, result: "error", msg: errMsg(e) }); }
    try { await sc.deleteEntity({ entityKey: k }); rec({ test: "t4-stranger-delete", label, result: "SUCCESS (BAD)" }); }
    catch (e) { rec({ test: "t4-stranger-delete", label, result: "error", msg: errMsg(e) }); }
  }
  // owner still fine
  const stillThere = await getExp(yes.entityKey);
  rec({ test: "t4-final", withFlagExpiresAt: stillThere, withoutFlagExpiresAt: await getExp(no.entityKey) });
}

async function t5() {
  const rows: any[] = [];
  for (let i = 0; i < 2; i++) {
    const a = await mk("conversation", ExpirationTime.max()); rows.push({ kind: "create-max", ...(await receiptInfo(a.txHash)), tx: a.txHash });
    const h = await mk("conversation", ExpirationTime.fromHours(1)); rows.push({ kind: "create-1h", ...(await receiptInfo(h.txHash)), tx: h.txHash });
    const x = await retry(() => wc.extendEntity({ entityKey: h.entityKey, expiration: ExpirationTime.max() })); rows.push({ kind: "extend-to-max", ...(await receiptInfo(x.txHash)), tx: x.txHash });
    await sleep(3000);
  }
  rec({ test: "t5-costs", rows: rows.map((r) => ({ ...r, feeTGLM: formatEther(r.feeWei) })) });
}

async function t6() {
  // short check: do watchEntityEvents emit anything at expiry? (sdk source says no event type exists)
  const events: any[] = [];
  const unwatch = pc.watchEntityEvents({ onEvent: (e: any) => events.push({ type: e.type ?? e.eventName ?? "?", block: e.blockNumber }), onError: () => {}, pollingInterval: 2000 } as any);
  const c = await mk("otp", ExpirationTime.fromSeconds(20));
  await sleep(50_000);
  unwatch();
  rec({ test: "t6-expiry-events", key: c.entityKey, eventsSeen: events, note: "events after create; any event at expiry block?" });
}

const which = process.argv[2] ?? "all";
const steps: Record<string, () => Promise<void>> = { wait, t1, t2, t3, t4, t5, t6 };
console.log("wallet", me.address);
if (which === "all") { await wait(); for (const k of ["t2", "t3", "t4", "t5", "t6", "t1"]) { try { await steps[k](); } catch (e) { rec({ test: k + "-FATAL", msg: errMsg(e) }); } } }
else await steps[which]();
