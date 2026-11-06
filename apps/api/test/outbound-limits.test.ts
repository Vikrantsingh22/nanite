/*
 * Outbound: reply threading, atomic per-agent cap and the Nanite-wide daily mail quota (real Postgres, fakes
 * for ENS, the mail provider and Arkiv). Fixtures use unique random data. File parallelism is off (see
 * vitest.config.ts) because the global quota counts rows of every test file.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmailRecord } from "@nanite/arkiv";
import { decryptEmail, encryptEmail, generateUserKeypair, keyId, ready, type EmailMeta, type Keypair } from "@nanite/crypto";
import { agents, countMailSince, createDb, domains, mailboxes, sendLog, userKeys, users, utcDayStart, webhookEvents } from "@nanite/db";
import type { SendPolicy } from "@nanite/ens";
import { and, eq, inArray, like } from "drizzle-orm";
import { InMemoryArkivWriter } from "../src/arkiv/port.js";
import { createApp } from "../src/app.js";
import { issueAgentToken } from "../src/agent-api/tokens.js";
import { provisionNaniteAgentKey } from "../src/agent-api/keys.js";
import { handleInboundEvent } from "../src/inbound/pipeline.js";
import { createFakeMailProvider } from "../src/mail/fake.js";
import type { OutboundEns, OutboundReader } from "../src/outbound/send.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
const SECRET = "test-sender-hash-secret-0123456789";
const MASTER = new Uint8Array(randomBytes(32));
const handle = createDb(DATABASE_URL, { max: 8 });
const tag = randomBytes(4).toString("hex");
const eventPrefix = `msg_lim_${tag}_`;
const logs: string[] = [];
const spies: string[] = [];

class FakeEns implements OutboundEns {
  policy: SendPolicy = { policy: "any", allow: [], limit: 50 };
  async readSendPolicy() {
    return { ...this.policy };
  }
  async resolveEmail() {
    return null;
  }
}
const ens = new FakeEns();
const arkiv = new InMemoryArkivWriter();
const provider = createFakeMailProvider({ webhookSecret: "whsec_" + Buffer.from("x".repeat(24)).toString("base64") });
const entities = new Map<string, EmailRecord>();
const reader: OutboundReader = {
  async listInbox() {
    return { items: [] };
  },
  async getEmail(k) {
    return entities.get(k) ?? null;
  },
};

interface Fx {
  id: string;
  ensName: string;
  token: string;
  kp: Keypair;
}
let userId: string;
let userKp: Keypair;
let a: Fx; // self custody
let b: Fx; // self custody
let n: Fx; // custody nanite (threading)
let mailboxAddr: string;
let domainId: string;

async function makeAgent(label: string, custody: "nanite" | "self", index: number): Promise<Fx> {
  const kp = await generateUserKeypair();
  const id = crypto.randomUUID();
  const ensName = `${label}-${tag}.lim.nanitecom.eth`;
  await handle.db.insert(agents).values({
    id, userId, name: `${label}${tag}`, derivationIndex: index, walletAddress: "0x" + randomBytes(20).toString("hex"),
    ensName, publicKey: Buffer.from(kp.publicKey), keyId: keyId(kp.publicKey), custody,
  });
  let realKp = kp;
  if (custody === "nanite") {
    // Server-held key: the API unseals it with the master key. Replace the fixture key with the sealed one's pair.
    const p = await provisionNaniteAgentKey(handle.db, id, MASTER);
    realKp = { publicKey: p.publicKey, privateKey: new Uint8Array(0) };
  }
  return { id, ensName, token: (await issueAgentToken(handle.db, id)).token, kp: realKp };
}

const app = (o: { quota?: number | undefined } = {}) =>
  createApp({
    db: { ping: async () => undefined },
    webOrigin: "http://localhost:3000",
    version: "t",
    log: (l) => logs.push(l),
    v1: {
      db: handle.db,
      reader: { listInbox: reader.listInbox as never, latestOtp: async () => null, getEmail: reader.getEmail as never },
      masterKey: MASTER,
      outbound: { provider, reader, arkiv, ens, senderHashSecret: SECRET, sharedMailDomain: "mail.nanite.test", dailyMailQuota: o.quota },
    },
  });

const send = (fx: Fx, body: unknown, a2: ReturnType<typeof app> = app()) =>
  a2.request("/v1/emails/send", {
    method: "POST",
    headers: { authorization: `Bearer ${fx.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
let seq = 0;
const msg = (extra: Record<string, unknown> = {}) => ({ to: `r${++seq}.${tag}@example.com`, subject: "limits subject", body: "limits body", ...extra });
const allowedRows = (id: string) =>
  handle.db.select().from(sendLog).where(and(eq(sendLog.agentId, id), eq(sendLog.policyDecision, "allowed")));
const deniedRows = (id: string) =>
  handle.db.select().from(sendLog).where(and(eq(sendLog.agentId, id), eq(sendLog.policyDecision, "denied")));
const todayCount = () => countMailSince(handle.db, utcDayStart(new Date()));
const total = async () => {
  const c = await todayCount();
  return c.sent + c.received;
};
const seedAllowed = async (id: string, count: number) => {
  for (let i = 0; i < count; i++) {
    await handle.db.insert(sendLog).values({ agentId: id, recipientHash: "seed", policyDecision: "allowed", policySnapshot: {} });
  }
};

beforeAll(async () => {
  await ready();
  for (const m of ["log", "error", "warn", "info", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...x: unknown[]) => void spies.push(x.map(String).join(" ")));
  }
  const [u] = await handle.db.insert(users).values({ walletAddress: "0x" + randomBytes(20).toString("hex"), username: `lim${tag}` }).returning({ id: users.id });
  userId = u!.id;
  userKp = await generateUserKeypair();
  const ph = Buffer.from("x");
  await handle.db.insert(userKeys).values({
    userId, publicKey: Buffer.from(userKp.publicKey), keyId: keyId(userKp.publicKey),
    wrappedPrivateKeyWallet: ph, wrappedPrivateKeyRecovery: ph, wrappedSeedWallet: ph, wrappedSeedRecovery: ph, walletSalt: ph, recoverySalt: ph,
  });
  a = await makeAgent("aa", "self", 0);
  b = await makeAgent("bb", "self", 1);
  n = await makeAgent("nn", "nanite", 2);
  const [d] = await handle.db.insert(domains).values({ name: `lim${tag}.test`, status: "verified" }).returning({ id: domains.id });
  domainId = d!.id;
  mailboxAddr = `aa${tag}@lim${tag}.test`;
  await handle.db.insert(mailboxes).values({ address: mailboxAddr, domainId, userId, agentId: a.id });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await handle.db.delete(webhookEvents).where(like(webhookEvents.providerEventId, `${eventPrefix}%`));
  await handle.db.delete(users).where(inArray(users.id, [userId]));
  await handle.db.delete(domains).where(eq(domains.id, domainId));
  await handle.close();
});

/** Source mail (as stored on Arkiv) for an agent, registered with the fake reader. */
async function source(fx: Fx, meta: EmailMeta | undefined, ownerEns = fx.ensName) {
  const pub = (await handle.db.select().from(agents).where(eq(agents.id, fx.id)))[0]!;
  const enc = await encryptEmail({ subject: "orig subject", body: "orig body", ...(meta ? { meta } : {}) }, [
    { keyId: keyId(userKp.publicKey), publicKey: userKp.publicKey },
    { keyId: pub.keyId, publicKey: new Uint8Array(pub.publicKey) },
  ]);
  const key = "0x" + randomBytes(32).toString("hex");
  entities.set(key, {
    ...enc, keyIds: enc.keyIds, agentId: ownerEns, type: "conversation", receivedAt: 1, threadId: "t", senderHash: "h",
    $key: key, $owner: "0x0", $creator: "0x0", $expiresAt: 1n,
  } as unknown as EmailRecord);
  return key;
}

describe("reply threading", () => {
  it("sets In-Reply-To / References from the encrypted meta and keeps linkage only in the encrypted copy", async () => {
    const key = await source(n, { messageId: "<orig@example.org>", references: ["<root@example.org>", "<mid@example.org>"], from: "x@example.org" });
    arkiv.writes.length = 0;
    const res = await send(n, msg({ inReplyTo: key, subject: "my own subject" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("threading");
    const m = provider.sent.at(-1)!;
    expect(m.subject).toBe("my own subject"); // never rewritten
    expect(m.headers!["In-Reply-To"]).toBe("<orig@example.org>");
    expect(m.headers!["References"]).toBe("<root@example.org> <mid@example.org> <orig@example.org>");
    expect(m.headers!["Message-ID"]).toMatch(/^<[0-9a-f-]{36}@mail\.nanite\.test>$/);

    const w = arkiv.writes[0]!;
    const rec = { ...w.fields, $key: "0x00", $owner: "0x0", $creator: "0x0", $expiresAt: 1n } as unknown as EmailRecord;
    const plain = await decryptEmail(rec, { keyId: keyId(userKp.publicKey), publicKey: userKp.publicKey, privateKey: userKp.privateKey });
    expect(plain.meta).toMatchObject({
      direction: "sent",
      inReplyTo: "<orig@example.org>",
      references: ["<root@example.org>", "<mid@example.org>", "<orig@example.org>"],
      messageId: m.headers!["Message-ID"],
    });
    const attrs = JSON.stringify(Object.entries(w.fields).filter(([k]) => !["ciphertext", "wrappedKeys", "nonce"].includes(k)));
    expect(attrs).not.toContain("example.org");
    expect(JSON.stringify(await deniedRows(n.id)) + JSON.stringify(await allowedRows(n.id))).not.toContain("example.org");
  });

  it("replies to a mail without a Message-ID go out unthreaded with threading:unavailable", async () => {
    const key = await source(n, { from: "x@example.org" });
    const res = await send(n, msg({ inReplyTo: key }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).threading).toBe("unavailable");
    const m = provider.sent.at(-1)!;
    expect(m.headers).not.toHaveProperty("In-Reply-To");
    expect(m.headers).not.toHaveProperty("References");
    const noMeta = await source(n, undefined);
    expect(((await (await send(n, msg({ inReplyTo: noMeta }))).json()) as Record<string, unknown>).threading).toBe("unavailable");
  });

  it("self-custody agents cannot be decrypted by the server: unavailable", async () => {
    const key = await source(a, { messageId: "<orig@example.org>" });
    const res = await send(a, msg({ inReplyTo: key }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).threading).toBe("unavailable");
    expect(provider.sent.at(-1)!.headers).not.toHaveProperty("In-Reply-To");
  });

  it("drops ids that are not clean <...> tokens (header injection) and an unusable Message-ID", async () => {
    const key = await source(n, {
      messageId: "<ok@example.org>",
      references: ["<a b@example.org>", "<x@example.org>\r\nBcc: evil@example.org", "not-an-id", "<good@example.org>", "<" + "z".repeat(300) + ">"],
    });
    expect((await send(n, msg({ inReplyTo: key }))).status).toBe(200);
    const h = provider.sent.at(-1)!.headers!;
    expect(h["References"]).toBe("<good@example.org> <ok@example.org>");
    expect(/[\r\n]/.test(h["References"]! + h["In-Reply-To"]!)).toBe(false);

    const bad = await source(n, { messageId: "<bad id@example.org>", references: ["<r@example.org>"] });
    const res = await send(n, msg({ inReplyTo: bad }));
    expect(((await res.json()) as Record<string, unknown>).threading).toBe("unavailable");
    expect(provider.sent.at(-1)!.headers).not.toHaveProperty("References");
  });

  it("caps a long References chain (root and the answered id are kept)", async () => {
    const refs = Array.from({ length: 40 }, (_, i) => `<ref${i}.${"p".repeat(40)}@example.org>`);
    const key = await source(n, { messageId: "<last@example.org>", references: refs });
    expect((await send(n, msg({ inReplyTo: key }))).status).toBe(200);
    const h = provider.sent.at(-1)!.headers!;
    const ids = h["References"]!.split(" ");
    expect(ids.length).toBeLessThanOrEqual(20);
    expect(h["References"]!.length).toBeLessThanOrEqual(900);
    expect(ids[0]).toBe(refs[0]);
    expect(ids.at(-1)).toBe("<last@example.org>");
    expect(h["In-Reply-To"]).toBe("<last@example.org>");
  });

  it("another agent's entity or an unknown key is 404 and consumes no quota", async () => {
    const foreign = await source(b, { messageId: "<f@example.org>" });
    const before = (await allowedRows(n.id)).length;
    expect((await send(n, msg({ inReplyTo: foreign }))).status).toBe(404);
    expect((await send(n, msg({ inReplyTo: "0x" + "ab".repeat(32) }))).status).toBe(404);
    expect((await allowedRows(n.id)).length).toBe(before);
  });
});

describe("atomic per-agent cap", () => {
  it("10 parallel sends with 1 slot left produce exactly one 200", async () => {
    await handle.db.delete(sendLog).where(eq(sendLog.agentId, a.id));
    ens.policy = { policy: "any", allow: [], limit: 3 };
    await seedAllowed(a.id, 2);
    const before = provider.sent.length;
    const res = await Promise.all(Array.from({ length: 10 }, () => send(a, msg())));
    const codes = res.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 429)).toHaveLength(9);
    for (const r of res.filter((r) => r.status === 429)) expect(await r.json()).toEqual({ error: "daily_limit" });
    expect(provider.sent.length - before).toBe(1);
    expect(await allowedRows(a.id)).toHaveLength(3);
    expect(await deniedRows(a.id)).toHaveLength(9);
  });

  it("10 parallel sends with 4 slots left produce exactly four 200s", async () => {
    await handle.db.delete(sendLog).where(eq(sendLog.agentId, a.id));
    ens.policy = { policy: "any", allow: [], limit: 6 };
    await seedAllowed(a.id, 2);
    const res = await Promise.all(Array.from({ length: 10 }, () => send(a, msg())));
    expect(res.filter((r) => r.status === 200)).toHaveLength(4);
    expect(await allowedRows(a.id)).toHaveLength(6);
  });
});

describe("global daily mail quota", () => {
  it("10 parallel sends across two agents with 3 slots left produce exactly three 200s", async () => {
    ens.policy = { policy: "any", allow: [], limit: 50 };
    for (const fx of [a, b]) await handle.db.delete(sendLog).where(eq(sendLog.agentId, fx.id));
    const quota = (await total()) + 3;
    const qa = app({ quota });
    const sentBefore = provider.sent.length;
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => send(i % 2 ? a : b, msg(), qa)));
    expect(res.filter((r) => r.status === 200)).toHaveLength(3);
    const refused = res.filter((r) => r.status === 429);
    expect(refused).toHaveLength(7);
    for (const r of refused) expect(await r.json()).toEqual({ error: "quota_exhausted" });
    expect(provider.sent.length - sentBefore).toBe(3);
    // Refusals are logged as denied (reason quota) and do not count as sent.
    const allowed = (await allowedRows(a.id)).length + (await allowedRows(b.id)).length;
    expect(allowed).toBe(3);
    const denied = [...(await deniedRows(a.id)), ...(await deniedRows(b.id))];
    expect(denied).toHaveLength(7);
    expect(denied.every((d) => (d.policySnapshot as { reason?: string }).reason === "quota_exhausted")).toBe(true);
    expect(await total()).toBe(quota);
  });

  it("received mail counts: duplicates and retries are not double counted, sends are refused at the cap", async () => {
    ens.policy = { policy: "any", allow: [], limit: 50 };
    const base = await todayCount();
    const inbound = { db: handle.db, provider, arkiv, senderHashSecret: SECRET, dailyMailQuota: 90 };
    const ev = (suffix: string, recipients = [mailboxAddr]) => ({
      kind: "received" as const, providerEventId: eventPrefix + suffix, emailId: `em_${tag}_${suffix}`, recipients,
    });
    const log = (f: Record<string, unknown>) => logs.push(JSON.stringify(f));
    expect((await handleInboundEvent(inbound, ev("1"), log)).status).toBe("stored");
    expect((await handleInboundEvent(inbound, ev("1"), log)).status).toBe("duplicate"); // same webhook delivered twice
    expect((await handleInboundEvent(inbound, ev("2"), log)).status).toBe("stored");
    expect((await handleInboundEvent(inbound, ev("3", [`nobody@lim${tag}.test`]), log)).status).toBe("dropped"); // still counted by Resend
    expect((await todayCount()).received - base.received).toBe(3);

    // At the cap the send is refused, with a denied row, and it is not counted as sent.
    const cur = await total();
    const sentBefore = (await todayCount()).sent;
    const res = await send(a, msg(), app({ quota: cur }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "quota_exhausted" });
    expect((await todayCount()).sent).toBe(sentBefore);
    // One below the cap the send goes through and now counts.
    expect((await send(a, msg(), app({ quota: cur + 1 }))).status).toBe(200);
    expect((await todayCount()).sent).toBe(sentBefore + 1);
    expect((await send(a, msg(), app({ quota: cur + 1 }))).status).toBe(429);
  });

  it("inbound is still stored over the quota and only logs a counts-only warning", async () => {
    const cur = await total();
    const warnings: string[] = [];
    const inbound = { db: handle.db, provider, arkiv, senderHashSecret: SECRET, dailyMailQuota: Math.max(0, cur - 1) };
    const writes = arkiv.writes.length;
    const r = await handleInboundEvent(
      inbound,
      { kind: "received", providerEventId: eventPrefix + "over", emailId: `em_${tag}_over`, recipients: [mailboxAddr] },
      (f) => warnings.push(JSON.stringify(f)),
    );
    expect(r).toEqual({ http: 200, status: "stored" });
    expect(arkiv.writes.length).toBe(writes + 1);
    const w = warnings.find((x) => x.includes("quota_exceeded"));
    expect(w).toBeDefined();
    expect(Object.keys(JSON.parse(w!)).sort()).toEqual(["event", "quota", "received", "sent"]);
    expect(warnings.join("\n")).not.toContain("@");
    // And the next send is refused.
    expect((await send(a, msg(), app({ quota: await total() }))).status).toBe(429);
  });

  it("without a configured quota only the per-agent cap applies", async () => {
    expect((await send(a, msg(), app())).status).toBe(200);
  });
});

describe("privacy", () => {
  it("never logs recipients, subjects or bodies", () => {
    const all = [...logs, ...spies].join("\n");
    for (const bad of [`@example.com`, "limits subject", "limits body", "example.org", `lim${tag}.test`]) expect(all).not.toContain(bad);
  });
});
