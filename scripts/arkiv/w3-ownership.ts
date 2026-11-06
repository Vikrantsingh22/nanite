// W3: who writes Arkiv entities? Ownership-model tests A-G. Addresses only; never log keys.
// Usage: docker compose run --rm tools npx tsx scripts/arkiv/w3-ownership.ts [A,B,C,D,E,F,G]
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { predictEntityKey } from "@arkiv-network/sdk";
import { eq } from "@arkiv-network/sdk/query";
import { addr, u64 } from "@arkiv-network/sdk/schema";
import { parseEther, formatEther, type Hex } from "viem";
import { account, publicClient, recordFinding, sleep, txUrl, walletFor } from "./lib";
import { EmailSchema } from "./schema";

const W = "W3";
const op = walletFor(3);
const usr = walletFor(4);
const wr = walletFor(8);
const OP = account(3).address;
const USR = account(4).address;
const WR = account(8).address;
const pc = publicClient();
const exp = () => ExpirationTime.fromHours(1);
const only = (process.argv[2] ?? "A,B,C,D,E,F,G").split(",");

const isRate = (e: unknown) => /429|rate|timeout|fetch failed|ECONN|HTTP request failed/i.test(String((e as Error)?.message ?? e));
/** Retry only transient RPC problems, never reverts. */
async function retry<T>(label: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      await sleep(1500);
      return await fn();
    } catch (e) {
      if (i >= tries || !isRate(e)) throw e;
      console.log(`  [${label}] transient error, retry ${i + 1}`);
      await sleep(5000 * (i + 1));
    }
  }
}
/** Expect a failure; returns the error text (first 400 chars) or null if it unexpectedly succeeded. */
async function expectFail(label: string, fn: () => Promise<unknown>): Promise<{ failed: boolean; error?: string; txHash?: string }> {
  try {
    const r = (await retry(label, fn)) as { txHash?: string };
    console.log(`  ${label}: UNEXPECTED SUCCESS`);
    return { failed: false, txHash: r?.txHash };
  } catch (e) {
    const msg = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 400);
    console.log(`  ${label}: failed as expected -> ${msg.slice(0, 160)}`);
    return { failed: true, error: msg };
  }
}
async function expectOk(label: string, fn: () => Promise<{ txHash: string }>) {
  const r = await retry(label, fn);
  console.log(`  ${label}: ok ${txUrl(r.txHash)}`);
  return r;
}

let seq = 0;
const mail = (tag: string, extra: Partial<Record<string, unknown>> = {}) => ({
  agentId: "w3-agent",
  ownerId: addr(USR),
  type: "conversation",
  receivedAt: u64(BigInt(Math.floor(Date.now() / 1000))),
  threadId: `w3-${tag}-${seq++}`,
  senderHash: "0".repeat(64),
  keyId: "k1",
  ciphertext: new Uint8Array([1, 2, 3, 4]),
  wrappedKeys: new Uint8Array([5, 6]),
  nonce: new Uint8Array([7, 8]),
  ...extra,
});

type Snap = { owner?: string; creator?: string; flags?: unknown; expiresAt?: unknown; threadId?: unknown };
async function read(key: Hex, pred: (s: Snap) => boolean = () => true, timeoutMs = 60_000): Promise<Snap | null> {
  const start = Date.now();
  let last: Snap | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const e: any = await pc.getEntity(key);
      last = { owner: e.$owner, creator: e.$creator, flags: e.$creationFlags, expiresAt: e.$expiresAt, threadId: e.threadId };
      if (pred(last)) return last;
    } catch {
      last = null;
    }
    await sleep(2500);
  }
  return last;
}
async function gone(key: Hex) {
  for (let i = 0; i < 20; i++) {
    try {
      await pc.getEntity(key);
    } catch (e) {
      if (!isRate(e)) return true;
    }
    await sleep(2500);
  }
  return false;
}
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const rec = (test: string, o: Record<string, unknown>) => {
  console.log(`[${test}]`, JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 600));
  recordFinding(W, { test, ...o });
};

/** One batch: N creates (predicted salts) + N transfers to USR. */
async function createAndTransfer(n: number, tag: string, flags?: { readonly?: boolean; permissionlessExtension?: boolean }, owner = OP, client = op, to = USR) {
  const preds = await retry("predict", () => pc.predictEntityKeys({ owner, count: n }));
  const r = await retry("batch", () =>
    client.executeBatch({
      creates: preds.map((p, i) => ({ schema: EmailSchema, values: mail(`${tag}${i}`), expiration: exp(), salt: p.salt, ...(flags ? { flags } : {}) })) as any,
      ownershipChanges: preds.map((p) => ({ entityKey: p.key, newOwner: to })),
    }),
  );
  return { preds, r };
}

async function main() {
  // ---- funding gate ----
  const start = Date.now();
  for (;;) {
    const bal = await retry("bal", () => pc.getBalance({ address: OP }));
    if (bal > 0n) { console.log("operator balance", formatEther(bal)); break; }
    if (Date.now() - start > 30 * 60_000) { console.log("OPERATOR STILL UNFUNDED after 30 min; stopping"); process.exit(2); }
    console.log("waiting for funding..."); await sleep(30_000);
  }
  const ubal = await retry("bal", () => pc.getBalance({ address: USR }));
  console.log("user balance", formatEther(ubal));

  const keys: Record<string, Hex[]> = {};

  if (only.includes("A")) {
    console.log("== A operator creates");
    const c = await retry("createA", () => op.createEntity(EmailSchema, mail("A") as any, { expiration: exp() }));
    const s = await read(c.entityKey);
    keys.A = [c.entityKey];
    const byUser = await retry("q", () => pc.select({ $key: true }).from(EmailSchema).ownedBy(USR).where(eq("agentId", "w3-agent")).fetch());
    const byCreator = await retry("q", () => pc.select({ $key: true }).from(EmailSchema).createdBy(OP).where(eq("threadId", s?.threadId as string ?? "w3-A-0")).fetch());
    rec("A", {
      txHash: c.txHash, entityKey: c.entityKey, owner: s?.owner, creator: s?.creator,
      ownerIsOperator: same(s?.owner, OP), creatorIsOperator: same(s?.creator, OP),
      ownedByUserQueryCount: byUser.entities.length,
      ownedByUserContainsKey: byUser.entities.some((x: any) => x.$key === c.entityKey),
      createdByOperatorQueryCount: byCreator.entities.length,
      createdByOperatorContainsKey: byCreator.entities.some((x: any) => x.$key === c.entityKey),
    });
  }

  if (only.includes("B") || only.includes("C")) {
    console.log("== B batch create+transfer");
    const one = await createAndTransfer(1, "B1");
    const s1 = await read(one.r.createdEntities[0], (s) => same(s.owner, USR));
    const keyMatch = one.preds[0].key === one.r.createdEntities[0];
    rec("B-single", { txHash: one.r.txHash, entityKey: one.r.createdEntities[0], predictedKeyMatches: keyMatch, ownershipChanges: one.r.ownershipChanges, owner: s1?.owner, creator: s1?.creator, ownerIsUser: same(s1?.owner, USR), creatorIsOperator: same(s1?.creator, OP) });
    const three = await createAndTransfer(3, "B3");
    const ss = [];
    for (const k of three.r.createdEntities) ss.push(await read(k, (s) => same(s.owner, USR)));
    rec("B-three", { txHash: three.r.txHash, singleTx: true, entityKeys: three.r.createdEntities, predictedKeysMatch: three.preds.every((p, i) => p.key === three.r.createdEntities[i]), owners: ss.map((s) => s?.owner), creators: ss.map((s) => s?.creator), allOwnedByUser: ss.every((s) => same(s?.owner, USR)), allCreatedByOperator: ss.every((s) => same(s?.creator, OP)) });
    const userQ = await retry("q", () => pc.select({ $key: true }).from(EmailSchema).ownedBy(USR).createdBy(OP).fetch());
    rec("B-query", { ownedByUserAndCreatedByOperatorCount: userQ.entities.length });
    keys.B = [one.r.createdEntities[0], ...three.r.createdEntities];

    if (only.includes("C")) {
      console.log("== C post-transfer permissions");
      const [k0, k1, k2] = [keys.B[1], keys.B[2], keys.B[3]];
      const out: Record<string, unknown> = {};
      out.operatorPatch = await expectFail("op patch", () => op.patchEntity(EmailSchema, k0, { set: { keyId: "evil" } } as any));
      out.operatorDelete = await expectFail("op delete", () => op.deleteEntity({ entityKey: k0 }));
      out.operatorExtend = await expectFail("op extend", () => op.extendEntity({ entityKey: k0, expiration: ExpirationTime.fromHours(2) }));
      out.operatorChangeOwnership = await expectFail("op changeOwnership", () => op.changeOwnership({ entityKey: k0, newOwner: OP }));
      const up = await expectOk("user patch", () => usr.patchEntity(EmailSchema, k0, { set: { keyId: "k2" } } as any));
      const ps = await read(k0);
      out.userPatch = { ok: true, txHash: up.txHash };
      const ux = await expectOk("user extend", () => usr.extendEntity({ entityKey: k1, expiration: ExpirationTime.fromHours(2) }));
      out.userExtend = { ok: true, txHash: ux.txHash };
      const ud = await expectOk("user delete", () => usr.deleteEntity({ entityKey: k2 }));
      out.userDelete = { ok: true, txHash: ud.txHash, goneAfter: await gone(k2) };
      rec("C", { patchedEntityKey: k0, extendedEntityKey: k1, deletedEntityKey: k2, ...out, ownerAfterPatch: ps?.owner });
    }
  }

  if (only.includes("D")) {
    console.log("== D permissionlessExtension, operator extends after transfer");
    const d = await createAndTransfer(1, "D", { permissionlessExtension: true });
    const k = d.r.createdEntities[0];
    const s = await read(k, (s) => same(s.owner, USR));
    const ex = await expectFail("op extend (perm-less)", () => op.extendEntity({ entityKey: k, expiration: ExpirationTime.fromHours(2) }));
    const pt = await expectFail("op patch (perm-less)", () => op.patchEntity(EmailSchema, k, { set: { keyId: "evil" } } as any));
    const dl = await expectFail("op delete (perm-less)", () => op.deleteEntity({ entityKey: k }));
    rec("D", { txHash: d.r.txHash, entityKey: k, flags: s?.flags, owner: s?.owner, creator: s?.creator, operatorExtendFailed: ex.failed, operatorExtendError: ex.error, operatorExtendTx: ex.txHash, operatorPatchFailed: pt.failed, operatorPatchError: pt.error, operatorDeleteFailed: dl.failed, operatorDeleteError: dl.error });
    keys.D = [k];
  }

  if (only.includes("E")) {
    console.log("== E nonce race");
    // E1: stale prediction. Predict, then land an unrelated create from the operator, then send the batch with the stale prediction.
    const stale = await retry("predict", () => pc.predictEntityKeys({ owner: OP, count: 1 }));
    const interloper = await retry("interloper", () => op.createEntity(EmailSchema, mail("E-interloper") as any, { expiration: exp() }));
    const nonceAfter = await retry("nonce", () => pc.getEntityNonce(OP));
    const e1 = await expectFail("stale batch", () =>
      op.executeBatch({
        creates: [{ schema: EmailSchema, values: mail("E1") as any, expiration: exp(), salt: stale[0].salt }] as any,
        ownershipChanges: [{ entityKey: stale[0].key, newOwner: USR }],
      }),
    );
    rec("E1-stale-prediction", { interloperTx: interloper.txHash, interloperKey: interloper.entityKey, stalePredictedKey: stale[0].key, nonceAfterInterloper: nonceAfter, staleBatchFailed: e1.failed, error: e1.error, unexpectedTx: e1.txHash });

    // E2: truly concurrent batches from the same operator, both predicted from the same nonce.
    const [pa, pb] = await Promise.all([retry("pa", () => pc.predictEntityKeys({ owner: OP, count: 1 })), retry("pb", () => pc.predictEntityKeys({ owner: OP, count: 1 }))]);
    const mk = (p: { key: Hex; salt: bigint }, t: string) =>
      op.executeBatch({ creates: [{ schema: EmailSchema, values: mail(t) as any, expiration: exp(), salt: p.salt }] as any, ownershipChanges: [{ entityKey: p.key, newOwner: USR }] });
    const res = await Promise.allSettled([mk(pa[0], "E2a"), mk(pb[0], "E2b")]);
    const summ = res.map((r) => (r.status === "fulfilled" ? { ok: true, txHash: r.value.txHash, created: r.value.createdEntities } : { ok: false, error: String((r.reason as Error).message).replace(/\s+/g, " ").slice(0, 300) }));
    // check who owns what after
    const checks = [];
    for (let i = 0; i < 2; i++) {
      const s = await read([pa, pb][i][0].key, undefined, 20_000);
      checks.push({ predictedKey: [pa, pb][i][0].key, exists: !!s, owner: s?.owner });
    }
    rec("E2-concurrent", { results: summ, checks });

    // E3: do explicit salts remove the nonce dependence? key = f(chain, creator, nonce, salt): compute locally.
    const n = await retry("nonce", () => pc.getEntityNonce(OP));
    const salt = 12345n;
    const k0 = predictEntityKey({ owner: OP, nonce: n, salt, chainId: 7794095 });
    const k1 = predictEntityKey({ owner: OP, nonce: n + 1n, salt, chainId: 7794095 });
    rec("E3-explicit-salt", { fixedSalt: salt, nonce: n, keyAtNonce: k0, keyAtNoncePlus1: k1, differ: k0 !== k1, note: "same explicit salt gives different keys at different nonces, so a salt does not remove the nonce dependence" });

    // E4: safe pattern = serialized queue; N sequential batches each re-predict immediately before send. Demonstrate 3 sequential.
    const seqRes = [];
    for (let i = 0; i < 3; i++) {
      const r = await createAndTransfer(1, `E4-${i}`);
      seqRes.push({ txHash: r.r.txHash, keyMatch: r.preds[0].key === r.r.createdEntities[0] });
    }
    rec("E4-serialized", { results: seqRes });
  }

  if (only.includes("F")) {
    console.log("== F derived writer key");
    const wb = await retry("bal", () => pc.getBalance({ address: WR }));
    if (wb < parseEther("0.02")) {
      const h = await retry("fund", () => op.sendTransaction({ to: WR, value: parseEther("0.05") }));
      await pc.waitForTransactionReceipt({ hash: h });
      console.log("  funded writer", txUrl(h));
      rec("F-fund", { txHash: h, from: OP, to: WR, amount: "0.05" });
    }
    const c = await retry("createF", () => wr.createEntity(EmailSchema, mail("F") as any, { expiration: exp() }));
    const s = await read(c.entityKey);
    // writer can still patch (it is owner)
    const p = await expectOk("writer patch", () => wr.patchEntity(EmailSchema, c.entityKey, { set: { keyId: "k2" } } as any));
    const t = await expectOk("writer->user changeOwnership", () => wr.changeOwnership({ entityKey: c.entityKey, newOwner: USR }));
    const s2 = await read(c.entityKey, (x) => same(x.owner, USR));
    const wp = await expectFail("writer patch after handover", () => wr.patchEntity(EmailSchema, c.entityKey, { set: { keyId: "k3" } } as any));
    const up = await expectOk("user patch after handover", () => usr.patchEntity(EmailSchema, c.entityKey, { set: { keyId: "k4" } } as any));
    rec("F", { txHash: c.txHash, entityKey: c.entityKey, owner: s?.owner, creator: s?.creator, ownerIsWriter: same(s?.owner, WR), creatorIsWriter: same(s?.creator, WR), writerPatchTx: p.txHash, handoverTx: t.txHash, ownerAfterHandover: s2?.owner, creatorAfterHandover: s2?.creator, writerPatchAfterHandoverFailed: wp.failed, writerPatchAfterHandoverError: wp.error, userPatchAfterHandoverTx: up.txHash });
  }

  if (only.includes("G")) {
    console.log("== G readonly + transfer");
    const g = await createAndTransfer(1, "G", { readonly: true });
    const k = g.r.createdEntities[0];
    const s = await read(k, (x) => same(x.owner, USR));
    const up = await expectFail("user patch readonly", () => usr.patchEntity(EmailSchema, k, { set: { keyId: "x" } } as any));
    const opp = await expectFail("op patch readonly", () => op.patchEntity(EmailSchema, k, { set: { keyId: "x" } } as any));
    const ux = await expectOk("user extend readonly", () => usr.extendEntity({ entityKey: k, expiration: ExpirationTime.fromHours(2) }));
    const ud = await expectOk("user delete readonly", () => usr.deleteEntity({ entityKey: k }));
    rec("G", { txHash: g.r.txHash, entityKey: k, flags: s?.flags, owner: s?.owner, creator: s?.creator, userPatchFailed: up.failed, userPatchError: up.error, operatorPatchFailed: opp.failed, operatorPatchError: opp.error, userExtendTx: ux.txHash, userDeleteTx: ud.txHash, goneAfterDelete: await gone(k) });
  }
  console.log("done");
}
main().catch((e) => { console.error("FATAL", String(e?.message ?? e).slice(0, 500)); process.exit(1); });
