/*
 * Self-hosted agents sign their own outbound mail (v3). The API verifies the signature against the agent's fresh
 * `nanite.signer` ENS record, applies the normal policy / limits / quota, and sends with exactly the client's
 * X-Nanite-* headers. Fakes only: no real mail, no chain.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailRecord } from "@nanite/arkiv";
import { canonicalSendStringV3, decryptEmail, generateUserKeypair, keyId, ready, type Keypair } from "@nanite/crypto";
import { agents, createDb, sendLog, userKeys, users } from "@nanite/db";
import { verifyNaniteSignature, type SendPolicy } from "@nanite/ens";
import { eq, inArray } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { issueAgentToken } from "../src/agent-api/tokens.js";
import { createApp } from "../src/app.js";
import { InMemoryArkivWriter } from "../src/arkiv/port.js";
import { createFakeMailProvider } from "../src/mail/fake.js";
import type { OutboundEns, OutboundReader } from "../src/outbound/send.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
const SECRET = "test-sender-hash-secret-0123456789";
const DOMAIN = "mail.nanite.test";
const SUBJECT = "SUBJECTMARKER-t37 hello";
const BODY = "BODYMARKER-t37 the body";
const TO = "friend.person@example.com";

const handle = createDb(DATABASE_URL, { max: 3 });
const tag = randomBytes(4).toString("hex");

class FakeEns implements OutboundEns {
  policy: SendPolicy = { policy: "any", allow: [], limit: 50 };
  signer: string | null = null;
  signerFails = false;
  async readSendPolicy() {
    return { ...this.policy };
  }
  async resolveEmail() {
    return null;
  }
  async readSigner() {
    if (this.signerFails) throw new Error("rpc");
    return this.signer;
  }
}
const noReader: OutboundReader = { listInbox: async () => ({ items: [] }), getEmail: async () => null };

const ens = new FakeEns();
const arkiv = new InMemoryArkivWriter();
const provider = createFakeMailProvider({ webhookSecret: "whsec_" + Buffer.from("x".repeat(24)).toString("base64") });
let userKp: Keypair;
let agentKp: Keypair;
let agentId: string;
let userId: string;
let wallet: string;
let ensName: string;
let from: string;
let token: string;
let signerKey = generatePrivateKey();

const app = createApp({
  db: { ping: async () => undefined },
  webOrigin: "http://localhost:3000",
  version: "t",
  log: () => undefined,
  v1: {
    db: handle.db,
    reader: { listInbox: noReader.listInbox as never, latestOtp: async () => null, getEmail: async () => null },
    outbound: { provider, reader: noReader, arkiv, ens, senderHashSecret: SECRET, sharedMailDomain: DOMAIN },
  },
});

interface Fields { to: string; subject: string; body: string; naniteMessageId: string; date: string }
const fresh = (over: Partial<Fields> = {}): Fields => ({
  to: TO,
  subject: SUBJECT,
  body: BODY,
  naniteMessageId: `<${randomUUID()}@${DOMAIN}>`,
  date: new Date().toUTCString(),
  ...over,
});
/** What the kit does: sign the canonical v3 string of exactly these fields. */
const sign = (f: Fields, key = signerKey) =>
  privateKeyToAccount(key).signMessage({ message: canonicalSendStringV3({ ensName, from, to: f.to, subject: f.subject, body: f.body, date: f.date, naniteMessageId: f.naniteMessageId }) });
async function signed(over: Partial<Fields> = {}, extra: Record<string, unknown> = {}, key = signerKey) {
  const f = fresh(over);
  return { ...f, signature: await sign(f, key), ...extra };
}
const send = (body: unknown, tok = token) =>
  app.request("/v1/emails/send", {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const err = async (r: Response) => ((await r.json()) as { error: string }).error;
const logRows = () => handle.db.select().from(sendLog).where(eq(sendLog.agentId, agentId));

beforeAll(async () => {
  await ready();
  wallet = "0x" + randomBytes(20).toString("hex");
  const [u] = await handle.db.insert(users).values({ walletAddress: wallet, username: `t37${tag}` }).returning({ id: users.id });
  userId = u!.id;
  userKp = await generateUserKeypair();
  agentKp = await generateUserKeypair();
  const ph = Buffer.from("x");
  await handle.db.insert(userKeys).values({
    userId, publicKey: Buffer.from(userKp.publicKey), keyId: keyId(userKp.publicKey),
    wrappedPrivateKeyWallet: ph, wrappedPrivateKeyRecovery: ph, wrappedSeedWallet: ph, wrappedSeedRecovery: ph, walletSalt: ph, recoverySalt: ph,
  });
  agentId = randomUUID();
  ensName = `kit-${tag}.t37.nanitecom.eth`;
  from = `kit${tag}@${DOMAIN}`;
  await handle.db.insert(agents).values({
    id: agentId, userId, name: `kit${tag}`, derivationIndex: 0, walletAddress: "0x" + randomBytes(20).toString("hex"),
    ensName, publicKey: Buffer.from(agentKp.publicKey), keyId: keyId(agentKp.publicKey), custody: "self",
    signerAddress: privateKeyToAccount(signerKey).address.toLowerCase(),
  });
  token = (await issueAgentToken(handle.db, agentId)).token;
  ens.signer = privateKeyToAccount(signerKey).address;
});
afterAll(async () => {
  await handle.db.delete(users).where(inArray(users.id, [userId]));
  await handle.close();
});

describe("GET /v1/me", () => {
  it("tells a self-hosted agent its ENS name, From address and custody", async () => {
    const r = await app.request("/v1/me", { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ensName, email: from, custody: "self", keyId: keyId(agentKp.publicKey) });
    expect((await app.request("/v1/me")).status).toBe(401);
  });
});

describe("POST /v1/emails/send for custody=self (agent-signed v3)", () => {
  it("valid: 200 signed, exactly the client's X-Nanite-* headers, verifiable against ENS, sent copy written", async () => {
    ens.policy = { policy: "any", allow: [], limit: 50 };
    const body = await signed();
    const writes = arkiv.writes.length;
    const res = await send(body);
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).toMatchObject({ status: "sent", signature: "signed" });
    const m = provider.sent.at(-1)!;
    expect(m.from).toBe(from);
    expect(m.to).toEqual([TO]);
    expect(m.headers).toEqual({
      "X-Nanite-Agent": ensName,
      "X-Nanite-Message-Id": body.naniteMessageId,
      "X-Nanite-Date": body.date,
      "X-Nanite-Signature": body.signature,
      "X-Nanite-Sig-Version": "3",
    });
    // A third party verifies it exactly like any other Nanite mail.
    const v = await verifyNaniteSignature(
      { headers: m.headers!, from: m.from, to: TO, subject: m.subject, body: m.text! },
      { ensClient: { getText: async () => ens.signer } },
    );
    expect(v).toMatchObject({ valid: true, reason: "ok" });
    // The send_log id is the client's uuid (this is what makes reuse impossible).
    const uuid = /^<(.+)@/.exec(body.naniteMessageId)![1]!;
    expect((await logRows()).find((r) => r.id === uuid)?.policyDecision).toBe("allowed");
    // The encrypted sent copy is written by the server for user and agent.
    expect(arkiv.writes.length).toBe(writes + 1);
    const w = arkiv.writes.at(-1)!;
    expect(w.fields.type).toBe("sent");
    const rec = { ...w.fields, $key: "0x00", $owner: wallet, $creator: wallet, $expiresAt: 1n } as unknown as EmailRecord;
    for (const kp of [userKp, agentKp]) {
      const plain = await decryptEmail(rec, { keyId: keyId(kp.publicKey), publicKey: kp.publicKey, privateKey: kp.privateKey });
      expect(plain).toMatchObject({ subject: SUBJECT, body: BODY, meta: { to: TO, direction: "sent", naniteMessageId: body.naniteMessageId } });
    }
  });

  it("bad signature, tampered content or a foreign key -> 401 invalid_signature, nothing sent or logged", async () => {
    const before = { sent: provider.sent.length, rows: (await logRows()).length };
    const good = await signed();
    expect(await err(await send({ ...good, body: good.body + " (tampered)" }))).toBe("invalid_signature");
    expect(await err(await send({ ...good, to: "other@example.com" }))).toBe("invalid_signature");
    const other = await signed({}, {}, generatePrivateKey());
    const res = await send(other);
    expect(res.status).toBe(401);
    expect(await err(res)).toBe("invalid_signature");
    expect(await err(await send({ ...good, signature: "0x" + "ab".repeat(65) }))).toBe("invalid_signature");
    expect(await err(await send({ ...good, signature: "nope" }))).toBe("invalid_signature");
    expect(provider.sent.length).toBe(before.sent);
    expect((await logRows()).length).toBe(before.rows);
  });

  it("a reused naniteMessageId is refused (409 message_id_reused) and nothing is sent twice", async () => {
    const body = await signed();
    expect((await send(body)).status).toBe(200);
    const sent = provider.sent.length;
    const again = await send(body);
    expect(again.status).toBe(409);
    expect(await err(again)).toBe("message_id_reused");
    expect(provider.sent.length).toBe(sent);
    // Same uuid with different content (re-signed) is also a reuse.
    const uuid = /^<(.+)@/.exec(body.naniteMessageId)![1]!;
    const re = await signed({ naniteMessageId: body.naniteMessageId, subject: "different" });
    expect(await err(await send(re))).toBe("message_id_reused");
    expect(uuid).toBeTruthy();
  });

  it("a policy denial does not burn the id", async () => {
    const body = await signed();
    ens.policy = { policy: "off", allow: [], limit: 50 };
    const sent = provider.sent.length;
    const denied = await send(body);
    expect(denied.status).toBe(403);
    expect(await err(denied)).toBe("policy_off");
    expect(provider.sent.length).toBe(sent);
    ens.policy = { policy: "any", allow: [], limit: 50 };
    expect((await send(body)).status).toBe(200);
  });

  it("date: within +-5 minutes, RFC 2822 UTC only", async () => {
    const at = (ms: number) => new Date(Date.now() + ms).toUTCString();
    expect((await send(await signed({ date: at(4 * 60_000) }))).status).toBe(200);
    expect((await send(await signed({ date: at(-4 * 60_000) }))).status).toBe(200);
    for (const ms of [6 * 60_000, -6 * 60_000, 3_600_000]) {
      const r = await send(await signed({ date: at(ms) }));
      expect(r.status).toBe(400);
      expect(await err(r)).toBe("date_skew");
    }
    for (const bad of ["2026-11-06T10:00:00Z", "Fri, 06 Nov 2026 10:00:00 +0100", "yesterday"]) {
      expect(await err(await send(await signed({ date: bad })))).toBe("invalid_date");
    }
  });

  it("the message id must be <uuid@mailbox domain>", async () => {
    for (const bad of [`<not-a-uuid@${DOMAIN}>`, `<${randomUUID()}@evil.example>`, randomUUID(), `<${randomUUID().toUpperCase()}@${DOMAIN}>`, `<${randomUUID()}@${DOMAIN}> <x@y>`]) {
      const r = await send(await signed({ naniteMessageId: bad }));
      expect(r.status).toBe(400);
      expect(await err(r)).toBe("invalid_message_id");
    }
  });

  it("all three of naniteMessageId, date and signature are required together", async () => {
    const full = await signed();
    for (const drop of ["naniteMessageId", "date", "signature"] as const) {
      const { [drop]: _x, ...partial } = full;
      expect(await err(await send(partial))).toBe("invalid_request");
    }
  });

  it("no signer record -> 409 no_signer; unreadable record -> 502 signer_unavailable; garbage record -> 409", async () => {
    const body = await signed();
    ens.signer = null;
    const none = await send(body);
    expect(none.status).toBe(409);
    expect(await err(none)).toBe("no_signer");
    ens.signer = "not-an-address";
    expect(await err(await send(body))).toBe("no_signer");
    ens.signerFails = true;
    const down = await send(body);
    expect(down.status).toBe(502);
    expect(await err(down)).toBe("signer_unavailable");
    ens.signerFails = false;
    ens.signer = privateKeyToAccount(signerKey).address;
    expect((await send(body)).status).toBe(200); // none of the failures consumed the id
  });

  it("after a rotation the OLD key stops working and the NEW one works (record read fresh every time)", async () => {
    const newKey = generatePrivateKey();
    const oldBody = await signed();
    const newBody = await signed({}, {}, newKey);
    ens.signer = privateKeyToAccount(newKey).address;
    const rejected = await send(oldBody);
    expect(rejected.status).toBe(401);
    expect(await err(rejected)).toBe("invalid_signature");
    expect((await send(newBody)).status).toBe(200);
    ens.signer = privateKeyToAccount(signerKey).address;
    expect(await err(await send(await signed({}, {}, newKey)))).toBe("invalid_signature");
  });

  it("the normal policy, daily limit and quota still apply", async () => {
    ens.policy = { policy: "allowlist", allow: ["ok@example.com"], limit: 50 };
    const no = await send(await signed({ to: "nope@example.com" }));
    expect(no.status).toBe(403);
    expect(await err(no)).toBe("policy_not_allowed");
    expect((await send(await signed({ to: "ok@example.com" }))).status).toBe(200);

    ens.policy = { policy: "reply-only", allow: [], limit: 50 };
    expect(await err(await send(await signed()))).toBe("policy_reply_only");

    await handle.db.delete(sendLog).where(eq(sendLog.agentId, agentId));
    ens.policy = { policy: "any", allow: [], limit: 1 };
    expect((await send(await signed())).status).toBe(200);
    const limited = await send(await signed());
    expect(limited.status).toBe(429);
    expect(await err(limited)).toBe("daily_limit");

    // Nanite-wide quota (sent + received) as well.
    await handle.db.delete(sendLog).where(eq(sendLog.agentId, agentId));
    ens.policy = { policy: "any", allow: [], limit: 50 };
    const quotaApp = createApp({
      db: { ping: async () => undefined },
      webOrigin: "http://localhost:3000",
      version: "t",
      log: () => undefined,
      v1: {
        db: handle.db,
        reader: { listInbox: noReader.listInbox as never, latestOtp: async () => null, getEmail: async () => null },
        outbound: { provider, reader: noReader, arkiv, ens, senderHashSecret: SECRET, sharedMailDomain: DOMAIN, dailyMailQuota: 0 },
      },
    });
    const q = await quotaApp.request("/v1/emails/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(await signed()),
    });
    expect(q.status).toBe(429);
    expect(await err(q)).toBe("quota_exhausted");
  });

  it("threading: client-supplied inReplyTo/references become In-Reply-To / References (sanitized) and live in the sent copy", async () => {
    ens.policy = { policy: "any", allow: [], limit: 50 };
    const res = await send(await signed({}, { inReplyTo: "<orig@sender.example>", references: ["<root@sender.example>", "bad ref", "<orig@sender.example>", 5] }));
    expect(res.status).toBe(200);
    const m = provider.sent.at(-1)!;
    expect(m.headers!["In-Reply-To"]).toBe("<orig@sender.example>");
    expect(m.headers!["References"]).toBe("<root@sender.example> <orig@sender.example>");
    const w = arkiv.writes.at(-1)!;
    const rec = { ...w.fields, $key: "0x00", $owner: wallet, $creator: wallet, $expiresAt: 1n } as unknown as EmailRecord;
    const plain = await decryptEmail(rec, { keyId: keyId(agentKp.publicKey), publicKey: agentKp.publicKey, privateKey: agentKp.privateKey });
    expect(plain.meta).toMatchObject({ inReplyTo: "<orig@sender.example>", references: ["<root@sender.example>", "<orig@sender.example>"] });

    for (const bad of ["not a msg id", "<a b@c>", "0x" + "ab".repeat(32), 7]) {
      expect(await err(await send(await signed({}, { inReplyTo: bad })))).toBe("invalid_in_reply_to");
    }
    expect(await err(await send(await signed({}, { inReplyTo: "<a@b>", references: "nope" })))).toBe("invalid_references");
    const none = await send(await signed());
    expect(none.status).toBe(200);
    expect(provider.sent.at(-1)!.headers).not.toHaveProperty("In-Reply-To");
  });

  it("legacy: a self agent that sends no signature fields still sends unsigned (policy applied)", async () => {
    ens.policy = { policy: "any", allow: [], limit: 50 };
    const res = await send({ to: TO, subject: "plain", body: "plain body" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { signature: string }).signature).toBe("unavailable");
    expect(provider.sent.at(-1)!.headers).not.toHaveProperty("X-Nanite-Signature");
  });

  it("send_log and responses never hold the recipient, subject or body", async () => {
    const dump = JSON.stringify(await logRows());
    for (const bad of [TO, "friend.person", "MARKER"]) expect(dump).not.toContain(bad);
  });
});
