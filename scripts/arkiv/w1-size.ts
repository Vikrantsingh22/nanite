// W1: size and cost. Usage: tsx scripts/arkiv/w1-size.ts <phase> ; phases: balance|t1|t2|t3|t4|t5|t6|all
import { randomBytes, createCipheriv } from "node:crypto";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { publicClient, walletFor, account, recordFinding, sleep, waitForQueryable, txUrl } from "./lib";
import { EmailSchema } from "./schema";
import { addr, u64 } from "@arkiv-network/sdk/schema";
import { formatEther, type Hex } from "viem";

const W = "W1";
const wc = walletFor(1);
const pc = publicClient();
const ME = account(1).address;
const MAX = 131072;

async function retry<T>(f: () => Promise<T>, tries = 6): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await f(); } catch (e) {
      last = e;
      const m = String((e as Error)?.message ?? e);
      if (/429|timeout|timed out|rate|fetch failed|ECONN/i.test(m) && !/revert|EntityMutation/i.test(m)) { await sleep(3000 * (i + 1)); continue; }
      throw e;
    }
  }
  throw last;
}

async function cost(txHash: Hex) {
  const r = await retry(() => pc.waitForTransactionReceipt({ hash: txHash }));
  const gasUsed = r.gasUsed, price = r.effectiveGasPrice;
  return { txHash, gasUsed, effectiveGasPrice: price, costWei: gasUsed * price, costTGLM: formatEther(gasUsed * price) };
}

const base = (ct: Uint8Array, i = 0) => ({
  agentId: "w1-agent", ownerId: addr(ME), type: "conversation", receivedAt: u64(BigInt(Math.floor(Date.now() / 1000))),
  threadId: `w1-t-${i}`, senderHash: "a".repeat(64), keyId: "k1",
  ciphertext: ct, wrappedKeys: randomBytes(160), nonce: randomBytes(12),
});

async function create(label: string, ct: Uint8Array, exp = ExpirationTime.fromHours(1), extra: Record<string, unknown> = {}) {
  const t0 = Date.now();
  try {
    const res = await retry(() => wc.createEntity(EmailSchema, base(ct) as any, { expiration: exp }));
    const c = await cost(res.txHash);
    const out = { test: label, ciphertextBytes: ct.length, ok: true, entityKey: res.entityKey, ms: Date.now() - t0, ...c, ...extra };
    console.log(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    recordFinding(W, out);
    return { ...out, res };
  } catch (e) {
    const out = { test: label, ciphertextBytes: ct.length, ok: false, errorName: (e as Error).name, error: String((e as Error).message).slice(0, 400), ...extra };
    console.log(JSON.stringify(out));
    recordFinding(W, out);
    return null;
  }
}

function typicalEmail(i = 0, emlBytes = 20 * 1024) {
  const key = randomBytes(32), iv = randomBytes(12);
  const body = Buffer.alloc(4096, `body${i} lorem ipsum `);
  const eml = randomBytes(emlBytes); // raw .eml incl. attachments ~ incompressible
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(Buffer.concat([body, eml])), c.final(), c.getAuthTag()]);
  return { ...base(enc, i), nonce: iv, wrappedKeys: Buffer.concat([randomBytes(80), randomBytes(80)]) };
}

const phases: Record<string, () => Promise<void>> = {
  async balance() {
    const b = await retry(() => pc.getBalance({ address: ME }));
    console.log("balance tGLM", formatEther(b));
  },
  async t1() {
    for (const kib of [1, 16, 64]) { await create(`t1-${kib}KiB`, randomBytes(kib * 1024)); await sleep(2000); }
    // other bytes: wrappedKeys 160 + nonce 12 = 172
    await create("t1-max (131072-172)", randomBytes(MAX - 172));
  },
  async t1b() {
    for (const kib of [80, 96, 112, 120, 126]) {
      const r = await create(`t1b-${kib}KiB`, randomBytes(kib * 1024 - 172));
      if (!r) break;
      await sleep(2000);
    }
  },
  async t1c() {
    // bisect between 122708 (ok) and 128852 (fail) ciphertext bytes
    let lo = 122708, hi = 128852;
    while (hi - lo > 64) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await create(`t1c-bisect-${mid}`, randomBytes(mid));
      if (r) lo = mid; else hi = mid;
      await sleep(2000);
    }
    console.log("boundary ok<=", lo, "fail>=", hi);
    recordFinding(W, { test: "t1c-boundary", maxOkCiphertextBytes: lo, minFailCiphertextBytes: hi, otherBytes: 172 });
  },
  async t2() {
    try {
      await wc.createEntity(EmailSchema, base(randomBytes(MAX - 172 + 1)) as any, { expiration: ExpirationTime.fromHours(1) });
      recordFinding(W, { test: "t2-over", ok: true, note: "SDK accepted MAX+1" });
    } catch (e) {
      const o = { test: "t2-over-sdk", errorName: (e as Error).name, error: String((e as Error).message).slice(0, 300) };
      console.log(o); recordFinding(W, o);
    }
    // single bytes column > 128 KiB
    try {
      await wc.createEntity(EmailSchema, base(randomBytes(MAX + 1)) as any, { expiration: ExpirationTime.fromHours(1) });
    } catch (e) {
      const o = { test: "t2-single-col-over", errorName: (e as Error).name, error: String((e as Error).message).slice(0, 300) };
      console.log(o); recordFinding(W, o);
    }
  },
  async t3() {
    const v = typicalEmail();
    const r = await create("t3-typical-email", v.ciphertext, ExpirationTime.fromHours(1), { wrapped: v.wrappedKeys.length });
    void r;
  },
  async t4() {
    // [count, emlBytes]: typical (4K body+20K eml) first; then small emails (4K body + 2K eml, e.g. OTP/short mail)
    for (const [n, eb] of [[4, 20480], [5, 20480], [10, 2048], [25, 2048]] as const) {
      const t0 = Date.now();
      try {
        const creates = Array.from({ length: n }, (_, i) => ({ schema: EmailSchema, values: typicalEmail(i, eb) as any, expiration: ExpirationTime.fromHours(1) }));
        const res: any = await retry(() => (wc as any).executeBatch({ creates }));
        const c = await cost(res.txHash);
        const out = { test: `t4-batch-${n}x${eb}`, n, emlBytes: eb, ok: true, created: res.createdEntities.length, perEmailTGLM: formatEther(c.costWei / BigInt(n)), perEmailGas: (c.gasUsed / BigInt(n)).toString(), ms: Date.now() - t0, ...c };
        console.log(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v))); recordFinding(W, out);
      } catch (e) {
        const o = { test: `t4-batch-${n}x${eb}`, emlBytes: eb, ok: false, errorName: (e as Error).name, error: String((e as Error).message).slice(0, 400) };
        console.log(o); recordFinding(W, o); continue;
      }
      await sleep(3000);
    }
  },
  async t5() {
    const ct = randomBytes(64 * 1024);
    const r = await create("t5-roundtrip-64KiB-create", ct);
    if (!r) return;
    await sleep(4000);
    const t0 = Date.now();
    await waitForQueryable(r.entityKey as Hex, { timeoutMs: 90_000 });
    const tIndexed = Date.now() - t0;
    const t1 = Date.now();
    const e: any = await retry(() => pc.getEntity(r.entityKey as Hex, EmailSchema as any));
    const ms = Date.now() - t1;
    const cv: any = e.ciphertext;
    console.log("ciphertext shape", typeof cv, cv?.constructor?.name, cv && typeof cv === "object" ? Object.keys(cv).slice(0, 5) : "");
    const raw: any = cv?.value ?? cv;
    const got = typeof raw === "string" ? Buffer.from(raw.replace(/^0x/, ""), "hex") : Buffer.from(raw as Uint8Array);
    const o = { test: "t5-roundtrip", byteExact: got.equals(Buffer.from(ct)), gotLen: got.length, getEntityMs: ms, waitUntilIndexedMs: tIndexed };
    console.log(o); recordFinding(W, o);
  },
  async t6() {
    const ct = randomBytes(4096);
    await create("t6-4KiB-1hour", ct, ExpirationTime.fromHours(1));
    await sleep(2000);
    await create("t6-4KiB-30days", ct, ExpirationTime.fromDays(30));
  },
};

const p = process.argv[2] ?? "balance";
const list = p === "all" ? ["t3", "t6", "t1", "t2", "t4", "t5"] : [p];
for (const k of list) { console.log("== phase", k); await phases[k](); await sleep(2000); }
