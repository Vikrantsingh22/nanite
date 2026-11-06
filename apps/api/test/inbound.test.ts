import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptEmail, ready } from "@nanite/crypto";
import { createDb } from "@nanite/db";
import { InMemoryArkivWriter, type ArkivWriterPort } from "../src/arkiv/port.js";
import { createApp } from "../src/app.js";
import { createRetentionSource, type RetentionSource } from "../src/retention.js";
import { bodyText, classify, extractLinks, parseFromAddress, threadId } from "../src/inbound/classify.js";
import { FAKE_FIXTURES, createFakeMailProvider, fixtureOf, type FakeMailProvider } from "../src/mail/fake.js";
import { signSvix, verifySvix } from "../src/mail/svix.js";
import { WebhookVerificationError } from "../src/mail/provider.js";
import { provisionDevKeys, type DevKeys } from "../scripts/provision-dev-keys.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
const SECRET = "whsec_" + Buffer.from("nanite-test-webhook-secret-0001").toString("base64");
const SENDER_SECRET = "test-sender-hash-secret-0123456789";
const SUBJECT = "Quarterly SUBJECTMARKER-91 numbers";
const BODY = "BODYMARKER-xyz the confidential figures are attached. Visit https://example.com/report?id=7 now.";
const SENDER = "leaker.person@example.org";
const OTP = "482913";

const handle = createDb(DATABASE_URL, { max: 2 });
let keys: DevKeys;
let logs: string[] = [];
let provider: FakeMailProvider;
let arkiv: InMemoryArkivWriter;
let seq = 0;

function makeApp(arkivPort: ArkivWriterPort = arkiv, withInbound = true, retention?: RetentionSource) {
  return createApp({
    db: { ping: async () => void (await handle.client`select 1`) },
    webOrigin: "http://localhost:3000",
    version: "t",
    log: (l) => logs.push(l),
    ...(withInbound
      ? { inbound: { db: handle.db, provider, arkiv: arkivPort, senderHashSecret: SENDER_SECRET, sync: true, ...(retention ? { retention } : {}) } }
      : {}),
  });
}

function eventBody(emailId: string, to: string[], subject = SUBJECT) {
  return JSON.stringify({
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: emailId,
      from: `Leaker <${SENDER}>`,
      to,
      bcc: [],
      cc: [],
      received_for: to,
      message_id: "<m1@example.org>",
      subject,
      attachments: [],
    },
  });
}

async function post(
  app: ReturnType<typeof makeApp>,
  body: string,
  opts: { id?: string; timestamp?: string; signature?: string } = {},
) {
  const id = opts.id ?? `msg_test_${Date.now()}_${++seq}`;
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const res = await app.request("/webhooks/resend", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": opts.signature ?? signSvix(SECRET, id, timestamp, body),
    },
    body,
  });
  return { res, id, json: (await res.clone().json()) as Record<string, unknown> };
}

const consoleSpies: string[] = [];

beforeAll(async () => {
  await ready();
  keys = await provisionDevKeys(handle.db);
  for (const m of ["log", "error", "warn", "info", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleSpies.push(a.map(String).join(" ")));
  }
  await handle.client`insert into mailboxes (address, domain_id, user_id, agent_id, status)
    select 'off@nanite.test', domain_id, user_id, agent_id, 'disabled' from mailboxes where address = 'alex@nanite.test'
    on conflict do nothing`;
  await handle.client`insert into mailboxes (address, domain_id, user_id, agent_id, status)
    select 'alex2@nanite.test', domain_id, user_id, agent_id, 'active' from mailboxes where address = 'alex@nanite.test'
    on conflict do nothing`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await handle.client`delete from webhook_events where provider_event_id like 'msg_test_%'`;
  await handle.client`delete from mailboxes where address in ('off@nanite.test', 'alex2@nanite.test')`;
  await handle.close();
});

beforeEach(() => {
  provider = createFakeMailProvider({ webhookSecret: SECRET });
  arkiv = new InMemoryArkivWriter();
});

describe("POST /webhooks/resend", () => {
  it("stores a valid event: encrypted for user AND agent, plaintext fields correct", async () => {
    const emailId = `em_conv_${++seq}`;
    provider = createFakeMailProvider({
      webhookSecret: SECRET,
      emails: { [emailId]: { subject: SUBJECT, text: BODY, from: `Leaker <${SENDER.toUpperCase()}>`, messageId: "<m1@example.org>", headers: { references: "<root@example.org> <m0@example.org>" } } },
    });
    const { res, json, id } = await post(makeApp(), eventBody(emailId, ["Alex <ALEX@nanite.test>"]));
    expect(res.status).toBe(200);
    expect(json).toEqual({ status: "stored" });
    expect(arkiv.writes).toHaveLength(1);

    const w = arkiv.writes[0]!;
    expect(w.fields.type).toBe("conversation");
    expect(w.permissionlessExtension).toBe(true);
    expect(w.ownerWallet).toBe("0xfad31e74f1cb69046bbb2e4a15ce653bee6936c0");
    expect(w.fields.agentId).toBe("alex.vikrant.nanitecom.eth");
    expect(w.fields.senderHash).toMatch(/^[0-9a-f]{64}$/);
    expect(w.fields.threadId).toMatch(/^[0-9a-f]{32}$/);
    expect([...w.fields.keyIds].sort()).toEqual([keys.user.keyId, keys.agent.keyId].sort());

    for (const reader of [keys.user, keys.agent]) {
      const plain = await decryptEmail(w.fields, {
        keyId: reader.keyId,
        publicKey: reader.publicKey,
        privateKey: reader.privateKey,
      });
      expect(plain.subject).toBe(SUBJECT);
      expect(plain.body).toBe(BODY);
      const meta = plain.meta!;
      expect(meta.links).toEqual(["https://example.com/report?id=7"]);
      expect(meta.otp).toBeUndefined();
      // sender address, Message-ID and References are inside the encrypted payload
      expect(meta.from).toBe(SENDER);
      expect(meta.messageId).toBe("<m1@example.org>");
      expect(meta.references).toEqual(["<root@example.org>", "<m0@example.org>"]);
    }
    // ...and nowhere in plaintext attributes
    const plainAttrs = JSON.stringify(Object.entries(w.fields).filter(([k]) => !["ciphertext", "wrappedKeys", "nonce"].includes(k)));
    expect(plainAttrs).not.toContain("example.org");
    expect(plainAttrs).not.toContain("leaker");

    const [row] = await handle.client`select status, arkiv_entity_key, error from webhook_events where provider_event_id = ${id}`;
    expect(row).toMatchObject({ status: "stored", error: null });
    expect(row!.arkiv_entity_key).toMatch(/^0xfake/);
    const [led] = await handle.client`select a.status, a.entity_key, a.tx_hash from arkiv_writes a join webhook_events e on e.id = a.webhook_event_id where e.provider_event_id = ${id}`;
    expect(led).toMatchObject({ status: "confirmed" });
    expect(led!.entity_key).toBe(row!.arkiv_entity_key);
    expect(led!.tx_hash).toMatch(/^0xfade/);
  });

  it("rejects a bad signature with 401 and no detail, and does nothing", async () => {
    const emailId = `em_bad_${++seq}`;
    const body = eventBody(emailId, ["alex@nanite.test"]);
    const { res, json } = await post(makeApp(), body, { signature: "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    expect(res.status).toBe(401);
    expect(json).toEqual({ error: "unauthorized" });
    // tampered body with a signature for the original
    const id = `msg_test_tamper_${++seq}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signSvix(SECRET, id, ts, body);
    const r2 = await makeApp().request("/webhooks/resend", {
      method: "POST",
      headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": sig },
      body: body.replace("em_bad", "em_evil"),
    });
    expect(r2.status).toBe(401);
    // missing headers
    expect((await makeApp().request("/webhooks/resend", { method: "POST", body })).status).toBe(401);
    expect(provider.fetched).toHaveLength(0);
    expect(arkiv.writes).toHaveLength(0);
  });

  it("rejects a stale timestamp (replay outside 5 minutes)", async () => {
    const body = eventBody(`em_old_${++seq}`, ["alex@nanite.test"]);
    const old = String(Math.floor(Date.now() / 1000) - 600);
    const { res } = await post(makeApp(), body, { timestamp: old });
    expect(res.status).toBe(401);
  });

  it("treats a replay of the same event as duplicate (no second enqueue)", async () => {
    const body = eventBody(`em_dup_${++seq}`, ["alex@nanite.test"]);
    const app = makeApp();
    const first = await post(app, body);
    expect(first.json).toEqual({ status: "stored" });
    const second = await post(app, body, { id: first.id });
    expect(second.res.status).toBe(200);
    expect(second.json).toEqual({ status: "duplicate" });
    expect(arkiv.writes).toHaveLength(1);
    expect(provider.fetched).toHaveLength(1);
  });

  it("drops unknown, disabled recipients without fetching any content", async () => {
    const app = makeApp();
    const unknown = await post(app, eventBody(`em_unk_${++seq}`, ["nobody@nanite.test"]));
    expect(unknown.res.status).toBe(200);
    expect(unknown.json).toEqual({ status: "dropped" });
    const disabled = await post(app, eventBody(`em_dis_${++seq}`, ["off@nanite.test"]));
    expect(disabled.json).toEqual({ status: "dropped" });
    expect(provider.fetched).toHaveLength(0);
    expect(arkiv.writes).toHaveLength(0);
    const [row] = await handle.client`select status from webhook_events where provider_event_id = ${unknown.id}`;
    expect(row!.status).toBe("dropped");
  });

  it("classifies an OTP mail; the code is only inside the encrypted payload", async () => {
    const emailId = `em_otp_${++seq}`; // fake provider serves a canned OTP mail for ids containing "otp"
    const { json } = await post(makeApp(), eventBody(emailId, ["alex@nanite.test"], "Your verification code"));
    expect(json).toEqual({ status: "stored" });
    const w = arkiv.writes[0]!;
    expect(w.fields.type).toBe("otp");
    expect(w.permissionlessExtension).toBe(false);
    expect(w.fields.type).toBe("otp");
    expect(JSON.stringify({ ...w.fields, ciphertext: 0, wrappedKeys: 0, nonce: 0 })).not.toContain(OTP);
    const plain = await decryptEmail(w.fields, {
      keyId: keys.agent.keyId,
      publicKey: keys.agent.publicKey,
      privateKey: keys.agent.privateKey,
    });
    expect(plain.meta!.otp).toBe(OTP);
  });

  it("marks failed (non-content code), returns 500, and a retry succeeds", async () => {
    let fail = true;
    const flaky: ArkivWriterPort = {
      writeEmail: async (i) => {
        if (fail) throw new Error(`boom ${SUBJECT} ${BODY}`);
        return arkiv.writeEmail(i);
      },
    };
    const body = eventBody(`em_fail_${++seq}`, ["alex@nanite.test"]);
    const app = makeApp(flaky);
    const first = await post(app, body);
    expect(first.res.status).toBe(500);
    expect(JSON.stringify(first.json)).not.toContain("BODYMARKER");
    const [row] = await handle.client`select status, error from webhook_events where provider_event_id = ${first.id}`;
    expect(row).toMatchObject({ status: "failed", error: "internal_error" });
    fail = false;
    const retry = await post(app, body, { id: first.id });
    expect(retry.json).toEqual({ status: "stored" });
    expect(arkiv.writes).toHaveLength(1);
  });

  it("retry after a mid-way failure does NOT write an already-confirmed recipient again", async () => {
    let calls = 0;
    let failSecond = true;
    const flaky: ArkivWriterPort = {
      writeEmail: async (i) => {
        calls += 1;
        // 2nd call of the first attempt fails (the first recipient is already confirmed by then)
        if (failSecond && calls === 2) throw Object.assign(new Error(`boom ${SUBJECT}`), { name: "ArkivWriteError" });
        return arkiv.writeEmail(i);
      },
    };
    const body = eventBody(`em_partial_${++seq}`, ["alex@nanite.test", "alex2@nanite.test"]);
    const app = makeApp(flaky);
    const first = await post(app, body);
    expect(first.res.status).toBe(500);
    expect(calls).toBe(2);
    const ledger = () =>
      handle.client`select a.status, a.entity_key, a.tx_hash, a.last_error, a.attempts, m.address
        from arkiv_writes a join mailboxes m on m.id = a.mailbox_id
        join webhook_events e on e.id = a.webhook_event_id
        where e.provider_event_id = ${first.id} order by (m.address = 'alex@nanite.test') desc`;
    let rows = await ledger();
    expect(rows.map((r) => r.status)).toEqual(["confirmed", "failed"]);
    expect(rows[1]!.last_error).toBe("arkiv_write_failed");
    const firstKey = rows[0]!.entity_key as string;
    expect(firstKey).toMatch(/^0xfake/);
    const [ev] = await handle.client`select status, error from webhook_events where provider_event_id = ${first.id}`;
    expect(ev).toMatchObject({ status: "failed", error: "arkiv_write_failed" });

    failSecond = false;
    const retry = await post(app, body, { id: first.id });
    expect(retry.json).toEqual({ status: "stored" });
    expect(calls).toBe(3); // only the failed recipient was written again
    expect(arkiv.writes).toHaveLength(2); // exactly one entity per recipient overall
    rows = await ledger();
    expect(rows.map((r) => r.status)).toEqual(["confirmed", "confirmed"]);
    expect(rows[0]!.entity_key).toBe(firstKey); // reused, not rewritten
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[1]!.attempts).toBe(2);
    const [stored] = await handle.client`select status, arkiv_entity_key from webhook_events where provider_event_id = ${first.id}`;
    expect(stored!.status).toBe("stored");
    expect((stored!.arkiv_entity_key as string).split(",")).toHaveLength(2);
  });

  it("answers 503 when the webhook is not configured, 200 ignored for other event types", async () => {
    const body = eventBody("x", ["alex@nanite.test"]);
    expect((await post(makeApp(arkiv, false), body)).res.status).toBe(503);
    const other = JSON.stringify({ type: "email.sent", data: {} });
    const { res, json } = await post(makeApp(), other);
    expect(res.status).toBe(200);
    expect(json).toEqual({ status: "ignored" });
  });

  it("never logs or stores subject, body, sender address or OTP code", async () => {
    // Run a conversation mail, an OTP mail and a failing mail through the pipeline, then inspect everything.
    const convId = `em_logc_${++seq}`;
    const otpId = `em_logotp_${++seq}`;
    provider = createFakeMailProvider({
      webhookSecret: SECRET,
      emails: {
        [convId]: { subject: SUBJECT, text: BODY, from: SENDER },
        [otpId]: { subject: SUBJECT, text: `${BODY} Your verification code is ${OTP}.`, from: SENDER },
      },
    });
    const failing: ArkivWriterPort = {
      writeEmail: async () => {
        throw new Error(`${SUBJECT} ${BODY} ${SENDER} ${OTP}`);
      },
    };
    const ids: string[] = [];
    ids.push((await post(makeApp(), eventBody(convId, ["alex@nanite.test"]))).id);
    ids.push((await post(makeApp(), eventBody(otpId, ["alex@nanite.test"]))).id);
    ids.push((await post(makeApp(failing), eventBody(convId + "f", ["alex@nanite.test"]))).id);
    await post(makeApp(), eventBody(convId, ["alex@nanite.test"]), { signature: "v1,bad" });

    const rows = await handle.client`select * from webhook_events where provider_event_id = any(${ids})`;
    const haystack = [logs.join("\n"), consoleSpies.join("\n"), JSON.stringify(rows)].join("\n");
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of ["SUBJECTMARKER", "BODYMARKER", SENDER, "leaker.person", OTP, "Quarterly"]) {
      expect(haystack).not.toContain(secret);
    }
  });
});

describe("retention: per-agent lifetimes (T3.8)", () => {
  const retentionOf = (read: () => Promise<{ otpTtlMinutes: number; mailTtlHours: number; extend: "on" | "off"; extendLimit: number; invalid?: number }>, calls?: { n: number }) =>
    createRetentionSource({ read: async () => { if (calls) calls.n++; return read(); } });
  const store = (app: ReturnType<typeof makeApp>, id: string, subject = SUBJECT) => post(app, eventBody(id, ["alex@nanite.test"], subject));

  it("without a retention source: OTP 5 minutes, conversation 48 hours, OTP never extendable, conversation extendable", async () => {
    await store(makeApp(), `em_ttl_otp_${++seq}`, "Your verification code");
    await store(makeApp(), `em_ttl_conv_${++seq}`);
    const [otp, conv] = arkiv.writes;
    expect(otp!.fields.type).toBe("otp");
    expect(otp!.expiresInSeconds).toBe(300);
    expect(otp!.permissionlessExtension).toBe(false);
    expect(conv!.fields.type).toBe("conversation");
    expect(conv!.expiresInSeconds).toBe(48 * 3600);
    expect(conv!.permissionlessExtension).toBe(true);
  });

  it("uses the agent's ENS values: otp-ttl for codes, mail-ttl for conversations", async () => {
    const r = retentionOf(async () => ({ otpTtlMinutes: 12, mailTtlHours: 6, extend: "on", extendLimit: 20 }));
    await store(makeApp(arkiv, true, r), `em_ttl2_otp_${++seq}`, "Your verification code");
    await store(makeApp(arkiv, true, r), `em_ttl2_conv_${++seq}`);
    expect(arkiv.writes.map((w) => [w.fields.type, w.expiresInSeconds, w.permissionlessExtension])).toEqual([
      ["otp", 12 * 60, false],
      ["conversation", 6 * 3600, true],
    ]);
  });

  it("reads ENS once per agent within 60 s, then again after the cache expires", async () => {
    let t = 1_000_000;
    const calls = { n: 0 };
    const r = createRetentionSource({
      read: async () => { calls.n++; return { otpTtlMinutes: 5, mailTtlHours: 24, extend: "on", extendLimit: 20 }; },
      now: () => t,
    });
    for (let i = 0; i < 3; i++) await store(makeApp(arkiv, true, r), `em_ttl3_${++seq}`);
    expect(calls.n).toBe(1);
    t += 59_000;
    await store(makeApp(arkiv, true, r), `em_ttl3_${++seq}`);
    expect(calls.n).toBe(1);
    t += 2_000;
    await store(makeApp(arkiv, true, r), `em_ttl3_${++seq}`);
    expect(calls.n).toBe(2);
    expect(arkiv.writes.every((w) => w.expiresInSeconds === 24 * 3600)).toBe(true);
  });

  it("a failed ENS read never blocks mail: defaults are used and only a count is logged", async () => {
    const lines: Record<string, unknown>[] = [];
    const r = createRetentionSource({ read: async () => { throw new Error(`rpc ${SUBJECT}`); }, log: (f) => lines.push(f) });
    const out = await store(makeApp(arkiv, true, r), `em_ttl4_${++seq}`);
    expect(out.json).toEqual({ status: "stored" });
    expect(arkiv.writes[0]!.expiresInSeconds).toBe(48 * 3600);
    expect(JSON.stringify(lines)).not.toContain("SUBJECTMARKER");
    expect(lines).toEqual([{ event: "retention_read_failed", fallback: "defaults" }]);
  });

  it("logs invalid ENS records as a count only", async () => {
    const lines: Record<string, unknown>[] = [];
    const r = createRetentionSource({
      read: async () => ({ otpTtlMinutes: 5, mailTtlHours: 48, extend: "on", extendLimit: 20, invalid: 2 }),
      log: (f) => lines.push(f),
    });
    await r.get("alex.vikrant.nanitecom.eth");
    expect(lines).toEqual([{ event: "retention_invalid_records", invalid: 2 }]);
  });
});

describe("dev inbox route", () => {
  const base = { db: { ping: async () => undefined }, webOrigin: "http://localhost:3000", version: "t", log: () => undefined };
  it("is absent unless devInbox is injected (index.ts does that only for DEV_ROUTES=1 outside production)", async () => {
    expect((await createApp(base).request("/internal/dev/inbox/alex.vikrant.nanitecom.eth")).status).toBe(404);
  });
  it("returns metadata only when enabled", async () => {
    const item = { key: "0xab", type: "otp", receivedAt: 1, $owner: "0x1", $creator: "0x2", $expiresAt: "9" };
    const app = createApp({ ...base, devInbox: { list: async () => [item] } });
    const res = await app.request("/internal/dev/inbox/Alex.vikrant.nanitecom.eth");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dev: true, agentEns: "alex.vikrant.nanitecom.eth", count: 1, items: [item] });
    expect((await app.request("/internal/dev/inbox/bad%20name")).status).toBe(400);
  });
});

describe("svix signature", () => {
  const secret = "whsec_plJ3nmyCDGBKInavdOK15jsl";
  const body = '{"event_type":"ping","data":{"success":true}}';
  const id = "msg_loFOjxBNrRLzqYUf";
  const ts = "1731705121";
  const sig = "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=";
  const raw = new TextEncoder().encode(body);
  const hdr = (s = sig, t = ts) =>
    new Headers({ "svix-id": id, "svix-timestamp": t, "svix-signature": s });
  const nowMs = Number(ts) * 1000;

  it("matches the published Svix test vector", () => {
    expect(signSvix(secret, id, ts, body)).toBe(sig);
    expect(verifySvix({ secret, rawBody: raw, headers: hdr(), nowMs })).toBe(id);
  });

  it("accepts any matching entry in a multi-signature header", () => {
    expect(verifySvix({ secret, rawBody: raw, headers: hdr(`v1,AAAA ${sig}`), nowMs })).toBe(id);
  });

  it("enforces the 5 minute tolerance in both directions", () => {
    expect(() => verifySvix({ secret, rawBody: raw, headers: hdr(), nowMs: nowMs + 299_000 })).not.toThrow();
    expect(() => verifySvix({ secret, rawBody: raw, headers: hdr(), nowMs: nowMs + 301_000 })).toThrow(WebhookVerificationError);
    expect(() => verifySvix({ secret, rawBody: raw, headers: hdr(), nowMs: nowMs - 301_000 })).toThrow(WebhookVerificationError);
  });

  it("rejects a modified body, wrong secret or non-v1 signature", () => {
    const bad = new TextEncoder().encode(body.replace("true", "false"));
    expect(() => verifySvix({ secret, rawBody: bad, headers: hdr(), nowMs })).toThrow(WebhookVerificationError);
    expect(() => verifySvix({ secret: "whsec_AAAAAAAA", rawBody: raw, headers: hdr(), nowMs })).toThrow(WebhookVerificationError);
    expect(() => verifySvix({ secret, rawBody: raw, headers: hdr(sig.replace("v1,", "v2,")), nowMs })).toThrow(WebhookVerificationError);
  });
});

describe("classification helpers", () => {
  it("detects OTPs with keyword + 4-8 digit code", () => {
    expect(classify("Your verification code", "Your verification code is 482913.")).toEqual({ type: "otp", otp: "482913" });
    expect(classify("Sign in", "Use passcode 1234 to log in")).toEqual({ type: "otp", otp: "1234" });
    expect(classify("Code: 123-456", "Here is your one-time code")).toEqual({ type: "otp", otp: "123456" });
  });

  it("keeps ordinary mail as conversation", () => {
    expect(classify("Lunch?", "Meet at 12345 Main Street at noon").type).toBe("conversation");
    expect(classify("Verify your account", "Click the link below to verify.").type).toBe("conversation");
    expect(classify("Invoice", `Total 2024. ${"x".repeat(3000)} verification code 123456`).type).toBe("conversation");
  });

  it("extracts and dedupes links from text and html", () => {
    const links = extractLinks("see https://a.example/x, and https://a.example/x.", '<a href="https://b.example/y">b</a>');
    expect(links).toEqual(["https://b.example/y", "https://a.example/x"]);
  });

  it("demo fixtures classify as intended (otp vs conversation) and carry a parseable sender", async () => {
    for (const [name, fx] of Object.entries(FAKE_FIXTURES)) {
      expect(fixtureOf(`fake-${name}-abc`)).toBe(fx);
      expect(parseFromAddress(fx.from!), name).not.toBeNull();
      const body = bodyText({ text: fx.text ?? null, html: fx.html ?? null });
      expect(classify(fx.subject!, body).type, name).toBe(name.startsWith("otp") ? "otp" : "conversation");
    }
    expect(fixtureOf("em_conv_1")).toBeUndefined();
  });

  it("parseFromAddress extracts a lowercase address and rejects junk", () => {
    expect(parseFromAddress('"Bob B" <Bob@Example.COM>')).toBe("bob@example.com");
    expect(parseFromAddress("plain@example.com")).toBe("plain@example.com");
    expect(parseFromAddress("not an address")).toBeNull();
    expect(parseFromAddress("")).toBeNull();
  });

  it("threadId is opaque, stable across a reply, and per user", () => {
    const orig = threadId(SENDER_SECRET, "u1", { id: "1", messageId: "<root@x.org>", headers: {} });
    const reply = threadId(SENDER_SECRET, "u1", {
      id: "2",
      messageId: "<reply@x.org>",
      headers: { "in-reply-to": "<root@x.org>", references: "<root@x.org>" },
    });
    expect(reply).toBe(orig);
    expect(orig).toMatch(/^[0-9a-f]{32}$/);
    expect(threadId(SENDER_SECRET, "u2", { id: "1", messageId: "<root@x.org>", headers: {} })).not.toBe(orig);
  });
});
