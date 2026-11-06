import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmailRecord } from "@nanite/arkiv";
import { decryptEmail, generateUserKeypair, keyId, ready, senderHash, type Keypair } from "@nanite/crypto";
import { agents, createDb, sendLog, userKeys, users } from "@nanite/db";
import type { SendPolicy } from "@nanite/ens";
import { eq, inArray } from "drizzle-orm";
import { InMemoryArkivWriter } from "../src/arkiv/port.js";
import { createApp } from "../src/app.js";
import { issueAgentToken } from "../src/agent-api/tokens.js";
import { RESEND_ERRORS, createFakeMailProvider } from "../src/mail/fake.js";
import type { OutboundEns, OutboundReader } from "../src/outbound/send.js";
import { arkivWrites } from "@nanite/db";
import { verifyNaniteSignature } from "@nanite/ens";
import { generateSealedSigner, unsealAgentSignerKey } from "../src/agent-api/keys.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
const SECRET = "test-sender-hash-secret-0123456789";
const SUBJECT = "SUBJECTMARKER-t35 plans";
const BODY = "BODYMARKER-t35 the secret body";
const TO = "friend.person@example.com";

const handle = createDb(DATABASE_URL, { max: 3 });
const tag = randomBytes(4).toString("hex");
const logs: string[] = [];
const consoleSpies: string[] = [];

class FakeEns implements OutboundEns {
  policy: SendPolicy = { policy: "off", allow: [], limit: 50 };
  emails: Record<string, string> = {};
  reads = 0;
  async readSendPolicy() {
    this.reads++;
    return { ...this.policy };
  }
  async resolveEmail(n: string) {
    return this.emails[n] ?? null;
  }
}
class FakeReader implements OutboundReader {
  received: { agentId: string; senderHash: string; type: "otp" | "conversation" }[] = [];
  async listInbox(o: Parameters<OutboundReader["listInbox"]>[0]) {
    const hit = this.received.filter(
      (r) => r.agentId === o.agentId && r.senderHash === o.senderHash && (!o.types || o.types.includes(r.type)),
    );
    return { items: hit.slice(0, 1) as unknown as EmailRecord[] };
  }
  async getEmail() {
    return null;
  }
}

const masterKey = new Uint8Array(randomBytes(32));
const ens = new FakeEns();
const reader = new FakeReader();
const arkiv = new InMemoryArkivWriter();
const provider = createFakeMailProvider({ webhookSecret: "whsec_" + Buffer.from("x".repeat(24)).toString("base64") });
let userId: string;
let wallet: string;
let userKp: Keypair;
let agentKp: Keypair;
let agentId: string;
let ensName: string;
let token: string;

const app = () =>
  createApp({
    db: { ping: async () => void (await handle.client`select 1`) },
    webOrigin: "http://localhost:3000",
    version: "t",
    log: (l) => logs.push(l),
    v1: {
      db: handle.db,
      masterKey,
      reader: { listInbox: reader.listInbox.bind(reader) as never, latestOtp: async () => null, getEmail: async () => null },
      outbound: {
        provider, reader, arkiv, ens, senderHashSecret: SECRET, sharedMailDomain: "mail.nanite.test",
        sleep: async (ms: number) => void sleeps.push(ms),
        log: (f: Record<string, unknown>) => void logs.push(JSON.stringify(f)),
      },
    },
  });
const sleeps: number[] = [];

const send =(body: unknown, tok: string = token, raw = false) =>
  app().request("/v1/emails/send", {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
const msg = (to = TO) => ({ to, subject: SUBJECT, body: BODY });
const rows = () => handle.db.select().from(sendLog).where(eq(sendLog.agentId, agentId));

beforeAll(async () => {
  await ready();
  for (const m of ["log", "error", "warn", "info", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleSpies.push(a.map(String).join(" ")));
  }
  wallet = "0x" + randomBytes(20).toString("hex");
  const [u] = await handle.db.insert(users).values({ walletAddress: wallet, username: `t35${tag}` }).returning({ id: users.id });
  userId = u!.id;
  userKp = await generateUserKeypair();
  agentKp = await generateUserKeypair();
  const ph = Buffer.from("x");
  await handle.db.insert(userKeys).values({
    userId, publicKey: Buffer.from(userKp.publicKey), keyId: keyId(userKp.publicKey),
    wrappedPrivateKeyWallet: ph, wrappedPrivateKeyRecovery: ph, wrappedSeedWallet: ph, wrappedSeedRecovery: ph, walletSalt: ph, recoverySalt: ph,
  });
  agentId = crypto.randomUUID();
  ensName = `alex-${tag}.t35.nanitecom.eth`;
  await handle.db.insert(agents).values({
    id: agentId, userId, name: `alex${tag}`, derivationIndex: 0, walletAddress: "0x" + randomBytes(20).toString("hex"),
    ensName, publicKey: Buffer.from(agentKp.publicKey), keyId: keyId(agentKp.publicKey), custody: "self",
  });
  token = (await issueAgentToken(handle.db, agentId)).token;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await handle.db.delete(users).where(inArray(users.id, [userId]));
  await handle.close();
});

describe("POST /v1/emails/send", () => {
  it("rejects missing, bad and revoked tokens with 401", async () => {
    expect((await send(msg(), "nan_" + "x".repeat(43))).status).toBe(401);
    const t = await issueAgentToken(handle.db, agentId);
    await handle.db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, agentId));
    expect((await send(msg(), t.token)).status).toBe(401);
    expect((await send(msg())).status).toBe(401);
    await handle.db.update(agents).set({ revokedAt: null }).where(eq(agents.id, agentId));
  });

  it("validates input and the 64 KiB body limit", async () => {
    ens.policy = { policy: "any", allow: [], limit: 50 };
    expect((await send({ ...msg(), to: "not-an-address" })).status).toBe(400);
    expect((await send({ ...msg(), to: "a@b.com, c@d.com" })).status).toBe(400);
    expect((await send({ to: TO, subject: "x\r\nBcc: y@z.com", body: "b" })).status).toBe(400);
    expect((await send("{not json", token, true)).status).toBe(400);
    expect((await send(JSON.stringify({ ...msg(), body: "a".repeat(70_000) }), token, true)).status).toBe(413);
  });

  it("off -> 403 policy_off, nothing sent", async () => {
    ens.policy = { policy: "off", allow: [], limit: 50 };
    const before = provider.sent.length;
    const res = await send(msg());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "policy_off" });
    expect(provider.sent.length).toBe(before);
  });

  it("reply-only: denied for strangers, allowed after they wrote to the agent", async () => {
    ens.policy = { policy: "reply-only", allow: [], limit: 50 };
    const res = await send(msg());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("policy_reply_only");
    // A "Name <addr>" style, differently-cased inbound sender hashes to the same value.
    reader.received.push({ agentId: ensName, senderHash: await senderHash(SECRET, userId, `Friend <${TO.toUpperCase()}>`), type: "conversation" });
    const ok = await send(msg());
    expect(ok.status).toBe(200);
    const b = (await ok.json()) as Record<string, unknown>;
    expect(b.status).toBe("sent");
    expect(b.providerMessageId).toMatch(/^fake-sent-/);
    expect(String(b.entityKey)).toMatch(/^0xfake/);
    expect(JSON.stringify(b)).not.toContain("MARKER");
  });

  it("allowlist: exact address, @domain, ENS name; others denied", async () => {
    ens.policy = { policy: "allowlist", allow: ["exact@example.com", "@corp.io", "bob.vik.nanitecom.eth"], limit: 50 };
    ens.emails["bob.vik.nanitecom.eth"] = "Bob@Elsewhere.org";
    expect((await send(msg("exact@example.com"))).status).toBe(200);
    expect((await send(msg("anyone@corp.io"))).status).toBe(200);
    expect((await send(msg("bob@elsewhere.org"))).status).toBe(200);
    for (const to of ["other@example.com", "x@sub.corp.io", "x@corp.io.evil.com"]) {
      const res = await send(msg(to));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("policy_not_allowed");
    }
  });

  it("any: allowed", async () => {
    ens.policy = { policy: "any", allow: [], limit: 50 };
    expect((await send(msg("whoever@example.net"))).status).toBe(200);
  });

  it("re-reads the policy on every request", async () => {
    ens.policy = { policy: "any", allow: [], limit: 50 };
    const r0 = ens.reads;
    expect((await send(msg("flip@example.com"))).status).toBe(200);
    ens.policy = { policy: "off", allow: [], limit: 50 };
    expect((await send(msg("flip@example.com"))).status).toBe(403);
    expect(ens.reads).toBe(r0 + 2);
  });

  it("a failing ENS read sends nothing (502)", async () => {
    const orig = ens.readSendPolicy;
    ens.readSendPolicy = async () => { throw new Error("rpc"); };
    const before = provider.sent.length;
    expect((await send(msg())).status).toBe(502);
    expect(provider.sent.length).toBe(before);
    ens.readSendPolicy = orig;
  });

  it("daily cap -> 429", async () => {
    await handle.db.delete(sendLog).where(eq(sendLog.agentId, agentId));
    ens.policy = { policy: "any", allow: [], limit: 2 };
    expect((await send(msg("c1@example.com"))).status).toBe(200);
    expect((await send(msg("c2@example.com"))).status).toBe(200);
    const res = await send(msg("c3@example.com"));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("daily_limit");
    ens.policy = { policy: "any", allow: [], limit: 0 };
    expect((await send(msg("c4@example.com"))).status).toBe(429);
  });

  it("provider message carries From, agent header and no signature without a signer", async () => {
    ens.policy = { policy: "any", allow: [], limit: 50 };
    await send(msg("hdr@example.com"));
    const m = provider.sent.at(-1)!;
    expect(m.from).toBe(`alex${tag}@mail.nanite.test`);
    expect(m.to).toEqual(["hdr@example.com"]);
    expect(m.headers!["X-Nanite-Agent"]).toBe(ensName);
    expect(m.headers).not.toHaveProperty("X-Nanite-Signature");
    expect(m.headers).not.toHaveProperty("X-Nanite-Sig-Version");
    expect(m.idempotencyKey).toBeTruthy();
  });

  it("self-custody agent (no signer): sends unsigned and says so in the response", async () => {
    ens.policy = { policy: "any", allow: [], limit: 50 };
    const res = await send(msg("unsigned@example.com"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { signature: string }).signature).toBe("unavailable");
  });

  it("send_log holds decisions and an HMAC only; sent copy decrypts for user and agent", async () => {
    await handle.db.delete(sendLog).where(eq(sendLog.agentId, agentId));
    arkiv.writes.length = 0;
    const to = "log.check@example.com";
    ens.policy = { policy: "allowlist", allow: [], limit: 50 };
    expect((await send(msg(to))).status).toBe(403);
    ens.policy = { policy: "any", allow: [], limit: 50 };
    const ok = await send(msg(to));
    expect(ok.status).toBe(200);

    const r = await rows();
    expect(r.map((x) => x.policyDecision).sort()).toEqual(["allowed", "denied"]);
    const h = await senderHash(SECRET, userId, to);
    expect(r.every((x) => x.recipientHash === h)).toBe(true);
    const dump = JSON.stringify(r) + JSON.stringify(await handle.db.select().from(arkivWrites).where(eq(arkivWrites.kind, "sent")));
    for (const bad of [to, "log.check", "example.com", "MARKER"]) expect(dump).not.toContain(bad);
    expect(r.find((x) => x.policyDecision === "allowed")!.providerMessageId).toMatch(/^fake-sent-/);

    expect(arkiv.writes).toHaveLength(1);
    const w = arkiv.writes[0]!;
    expect(w.fields.type).toBe("sent");
    expect(w.fields.agentId).toBe(ensName);
    expect(w.fields.senderHash).toBe(h);
    expect(w.permissionlessExtension).toBe(true);
    expect(w.ownerWallet).toBe(wallet);
    const rec = { ...w.fields, $key: "0x00", $owner: wallet, $creator: wallet, $expiresAt: 1n } as unknown as EmailRecord;
    for (const [kp] of [[userKp], [agentKp]] as const) {
      const plain = await decryptEmail(rec, { keyId: keyId(kp.publicKey), publicKey: kp.publicKey, privateKey: kp.privateKey });
      expect(plain.subject).toBe(SUBJECT);
      expect(plain.body).toBe(BODY);
      expect(plain.meta?.to).toBe(to);
      expect(plain.meta?.direction).toBe("sent");
    }
    // Ciphertext attributes carry nothing readable.
    expect(JSON.stringify(Object.values(w.fields).filter((v) => typeof v === "string"))).not.toContain(to);
    // Ledger row is confirmed.
    const led = await handle.db.select().from(arkivWrites).where(eq(arkivWrites.kind, "sent"));
    expect(led.some((l) => l.status === "confirmed" && l.entityKey?.startsWith("0xfake"))).toBe(true);
  });

  it("reports sentCopy failed (but still sent) when Arkiv fails", async () => {
    ens.policy = { policy: "any", allow: [], limit: 50 };
    const broken = { writeEmail: async () => { throw new Error("boom TO-LEAK"); } };
    const a = createApp({
      db: { ping: async () => undefined },
      webOrigin: "http://localhost:3000",
      version: "t",
      log: (l) => logs.push(l),
      v1: { db: handle.db, reader: reader as never, outbound: { provider, reader, arkiv: broken, ens, senderHashSecret: SECRET, sharedMailDomain: "mail.nanite.test" } },
    });
    const res = await a.request("/v1/emails/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(msg("arkivfail@example.com")),
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, unknown>;
    expect(b.entityKey).toBeNull();
    expect(b.sentCopy).toBe("failed");
  });

  it("never logs subject, body or recipient", () => {
    const all = [...logs, ...consoleSpies].join("\n");
    for (const bad of ["MARKER", "friend.person", "example.com", "corp.io", "TO-LEAK"]) expect(all).not.toContain(bad);
  });
});

describe("provider errors on send (Resend's documented error bodies)", () => {
  const err = (r: Response) => r.json().then((j) => (j as { error: string }).error);
  const counted = async () => (await rows()).filter((x) => x.policyDecision === "allowed").length;

  beforeAll(() => {
    ens.policy = { policy: "any", allow: [], limit: 50 };
  });

  async function fresh() {
    await handle.db.delete(sendLog).where(eq(sendLog.agentId, agentId));
    sleeps.length = 0;
    ens.policy = { policy: "any", allow: [], limit: 50 };
  }

  it.each([
    ["daily_quota_exceeded", RESEND_ERRORS.dailyQuota],
    ["monthly_quota_exceeded", RESEND_ERRORS.monthlyQuota],
  ])("%s -> 429 quota_exhausted, one attempt, the reserved row does not count", async (_n, failure) => {
    await fresh();
    provider.failNext("send", failure);
    const calls = provider.sendCalls;
    const res = await send(msg("q@example.com"));
    expect(res.status).toBe(429);
    expect(await err(res)).toBe("quota_exhausted");
    expect(provider.sendCalls - calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(await counted()).toBe(0);
    const [r] = await rows();
    expect(r).toMatchObject({ policyDecision: "denied", providerMessageId: null });
    expect(r!.policySnapshot).toMatchObject({ reason: "send_failed", sendFailed: true, error: "quota_exhausted" });
  });

  it("rate_limit_exceeded: one retry after retry-after (capped at 2 s) with the SAME Idempotency-Key, then 200", async () => {
    await fresh();
    provider.failNext("send", { ...RESEND_ERRORS.rateLimit, retryAfter: 1 });
    const calls = provider.sendCalls;
    const res = await send(msg("rl1@example.com"));
    expect(res.status).toBe(200);
    expect(sleeps).toEqual([1000]);
    expect(provider.sendCalls - calls).toBe(2);
    expect(await counted()).toBe(1);
    expect(provider.sent.at(-1)!.idempotencyKey).toBe((await rows())[0]!.id);
  });

  it("rate_limit_exceeded twice -> 429 rate_limited; a huge retry-after is capped at 2 s; the row does not count", async () => {
    await fresh();
    provider.failNext("send", { ...RESEND_ERRORS.rateLimit, retryAfter: 60 }, { ...RESEND_ERRORS.rateLimit, retryAfter: 60 });
    const res = await send(msg("rl2@example.com"));
    expect(res.status).toBe(429);
    expect(await err(res)).toBe("rate_limited");
    expect(sleeps).toEqual([2000]);
    expect(await counted()).toBe(0);
  });

  it.each([
    ["500 application_error", RESEND_ERRORS.applicationError],
    ["503 service_unavailable", RESEND_ERRORS.unavailable],
    ["network error", RESEND_ERRORS.network],
  ])("%s: one retry with the same key; recovers (200) or ends as 502 send_failed", async (_n, failure) => {
    await fresh();
    provider.failNext("send", failure);
    const ok = await send(msg("t1@example.com"));
    expect(ok.status).toBe(200);
    expect(sleeps).toHaveLength(1);
    expect(await counted()).toBe(1);

    await fresh();
    provider.failNext("send", failure, failure);
    const before = provider.sendCalls;
    const bad = await send(msg("t2@example.com"));
    expect(bad.status).toBe(502);
    expect(await err(bad)).toBe("send_failed");
    expect(provider.sendCalls - before).toBe(2);
    expect(await counted()).toBe(0);
  });

  it("403 validation_error (domain not verified) -> 502 sender_domain_unverified, no retry, not counted", async () => {
    await fresh();
    provider.failNext("send", RESEND_ERRORS.domainNotVerified);
    const before = provider.sendCalls;
    const res = await send(msg("d@example.com"));
    expect(res.status).toBe(502);
    expect(await err(res)).toBe("sender_domain_unverified");
    expect(provider.sendCalls - before).toBe(1);
    expect(await counted()).toBe(0);
  });

  it.each([
    ["401 restricted_api_key", RESEND_ERRORS.restrictedKey401],
    ["403 restricted_api_key", RESEND_ERRORS.restrictedKey403],
    ["401 validation_error (invalid key)", RESEND_ERRORS.invalidKey],
  ])("%s -> 503 send_unavailable (config), logged by name only, not counted", async (_n, failure) => {
    await fresh();
    provider.failNext("send", failure);
    const res = await send(msg("k@example.com"));
    expect(res.status).toBe(503);
    expect(await err(res)).toBe("send_unavailable");
    expect(await counted()).toBe(0);
    const line = logs.filter((l) => l.includes('"outcome":"config_error"')).at(-1)!;
    expect(line).toBeDefined();
    expect(line).not.toContain("restricted to only send");
  });

  it("a 409 idempotency conflict is not retried blindly: concurrent -> one retry, invalid -> 502 send_failed", async () => {
    await fresh();
    provider.failNext("send", RESEND_ERRORS.invalidIdempotent);
    const before = provider.sendCalls;
    const res = await send(msg("i@example.com"));
    expect(res.status).toBe(502);
    expect(provider.sendCalls - before).toBe(1);
    await fresh();
    provider.failNext("send", RESEND_ERRORS.concurrentIdempotent);
    expect((await send(msg("i2@example.com"))).status).toBe(200);
  });

  it("failed sends free the per-agent cap", async () => {
    await fresh();
    ens.policy = { policy: "any", allow: [], limit: 1 };
    provider.failNext("send", RESEND_ERRORS.applicationError, RESEND_ERRORS.applicationError);
    expect((await send(msg("cap1@example.com"))).status).toBe(502);
    expect((await send(msg("cap2@example.com"))).status).toBe(200); // the failed one did not use the single slot
    expect((await send(msg("cap3@example.com"))).status).toBe(429);
    ens.policy = { policy: "any", allow: [], limit: 50 };
  });

  it("no error body text reaches the response or the logs", async () => {
    await fresh();
    provider.failNext("send", { status: 403, name: "validation_error", message: "LEAK-THIS-MESSAGE for friend.person" });
    const res = await send(msg("leak@example.com"));
    expect(JSON.stringify(await res.json()) + logs.join("\n") + consoleSpies.join("\n")).not.toContain("LEAK-THIS");
  });
});

describe("signed outbound mail (option B)", () => {
  const records = new Map<string, string>();
  const ensClient = { getText: async (name: string, key: string) => (key === "nanite.signer" ? (records.get(name) ?? null) : null) };
  let signerHex = "";

  async function giveSigner() {
    const s = await generateSealedSigner(masterKey, agentId);
    await handle.db.update(agents).set({ signerAddress: s.address.toLowerCase(), signerKeySealed: Buffer.from(s.sealed) }).where(eq(agents.id, agentId));
    signerHex = Buffer.from(await unsealAgentSignerKey(masterKey, agentId, s.sealed)).toString("hex");
    return s.address;
  }
  const lastMail = () => provider.sent.at(-1)!;
  const verifyLast = (over: Partial<{ to: string; subject: string; body: string; from: string }> = {}) => {
    const m = lastMail();
    return verifyNaniteSignature(
      { headers: m.headers!, from: m.from, to: m.to[0]!, subject: m.subject, body: m.text!, ...over },
      { ensClient },
    );
  };

  it("signs with the agent's signer key: v3 headers verify against the ENS record", async () => {
    await handle.db.delete(sendLog).where(eq(sendLog.agentId, agentId));
    ens.policy = { policy: "any", allow: [], limit: 50 };
    const address = await giveSigner();
    records.set(ensName, address);
    const res = await send(msg("signed@example.com"));
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, unknown>;
    expect(b.signature).toBe("signed");
    const m = lastMail();
    expect(Object.keys(m.headers!).sort()).toEqual(
      ["X-Nanite-Agent", "X-Nanite-Date", "X-Nanite-Message-Id", "X-Nanite-Sig-Version", "X-Nanite-Signature"].sort(),
    );
    expect(m.headers).not.toHaveProperty("Message-ID");
    expect(m.headers!["X-Nanite-Message-Id"]).toMatch(/^<[0-9a-f-]{36}@mail\.nanite\.test>$/);
    expect(m.headers!["X-Nanite-Sig-Version"]).toBe("3");
    expect(m.headers!["X-Nanite-Signature"]).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await verifyLast()).toEqual({ valid: true, agent: ensName, signer: address, reason: "ok" });
    // Tampering with anything the signature covers breaks it.
    for (const over of [{ subject: SUBJECT + "!" }, { body: BODY + "!" }, { to: "evil@example.com" }, { from: "evil@mail.nanite.test" }]) {
      expect((await verifyLast(over)).reason).toBe("signer_mismatch");
    }
    const tampered = { ...lastMail().headers!, "X-Nanite-Date": "Mon, 01 Jan 2029 00:00:00 GMT" };
    expect((await verifyNaniteSignature({ headers: tampered, from: m.from, to: m.to[0]!, subject: m.subject, body: m.text! }, { ensClient })).valid).toBe(false);
    const swapped = { ...lastMail().headers!, "X-Nanite-Message-Id": "<00000000-0000-4000-8000-000000000000@mail.nanite.test>" };
    expect((await verifyNaniteSignature({ headers: swapped, from: m.from, to: m.to[0]!, subject: m.subject, body: m.text! }, { ensClient })).reason).toBe("signer_mismatch");
    // The provider replaces Message-ID (Resend/SES): v3 does not care.
    const replaced = { ...lastMail().headers!, "Message-ID": "<010601abc-0000@eu-west-1.amazonses.com>" };
    expect((await verifyNaniteSignature({ headers: replaced, from: m.from, to: m.to[0]!, subject: m.subject, body: m.text! }, { ensClient })).valid).toBe(true);
    // Neither the response nor the logs carry the key.
    const all = [JSON.stringify(b), ...logs, ...consoleSpies].join("\n");
    expect(all).not.toContain(signerHex);
  });

  it("rotation: mail signed with the old key fails against the new record, new mail verifies", async () => {
    const oldHeadersMail = lastMail();
    const oldAddress = records.get(ensName)!;
    const newAddress = await giveSigner();
    expect(newAddress).not.toBe(oldAddress);
    // The ENS record is published first in the real flow; until then the new key's mail does not verify.
    ens.policy = { policy: "any", allow: [], limit: 50 };
    expect((await send(msg("rot1@example.com"))).status).toBe(200);
    expect((await verifyLast()).reason).toBe("signer_mismatch");
    records.set(ensName, newAddress);
    expect((await verifyLast()).valid).toBe(true);
    expect((await send(msg("rot2@example.com"))).status).toBe(200);
    expect((await verifyLast()).valid).toBe(true);
    // The first mail (old key) is now invalid against the rotated record.
    const old = await verifyNaniteSignature(
      { headers: oldHeadersMail.headers!, from: oldHeadersMail.from, to: oldHeadersMail.to[0]!, subject: oldHeadersMail.subject, body: oldHeadersMail.text! },
      { ensClient },
    );
    expect(old).toMatchObject({ valid: false, reason: "signer_mismatch", signer: newAddress });
  });

  it("a signing failure (bad blob / no master key) still sends, unsigned, with signature unavailable", async () => {
    ens.policy = { policy: "any", allow: [], limit: 50 };
    await handle.db.update(agents).set({ signerKeySealed: Buffer.from("not a sealed key") }).where(eq(agents.id, agentId));
    const before = provider.sent.length;
    const res = await send(msg("badblob@example.com"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { signature: string }).signature).toBe("unavailable");
    expect(provider.sent.length).toBe(before + 1);
    expect(lastMail().headers).not.toHaveProperty("X-Nanite-Signature");
    expect(lastMail().headers).not.toHaveProperty("X-Nanite-Sig-Version");

    await giveSigner();
    const noMaster = createApp({
      db: { ping: async () => undefined },
      webOrigin: "http://localhost:3000",
      version: "t",
      log: (l) => logs.push(l),
      v1: { db: handle.db, reader: reader as never, outbound: { provider, reader, arkiv, ens, senderHashSecret: SECRET, sharedMailDomain: "mail.nanite.test" } },
    });
    const r2 = await noMaster.request("/v1/emails/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(msg("nomaster@example.com")),
    });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { signature: string }).signature).toBe("unavailable");
    expect(lastMail().headers).not.toHaveProperty("X-Nanite-Signature");
  });

  it("nothing in the logs contains a signer key", () => {
    expect([...logs, ...consoleSpies].join("\n")).not.toContain(signerHex);
  });
});
