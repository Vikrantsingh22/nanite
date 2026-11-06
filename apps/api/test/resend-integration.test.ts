/*
 * Real-Resend integration gaps (docs/resend-integration.md): G3 (html_format=cid, size caps), G6 (terminal provider
 * errors on fetch), G17 (fake speaks Resend's HTTP shapes) and the async webhook (early 200, background processing,
 * crash recovery, no double write). Errors use Resend's documented bodies { statusCode, name, message }.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptEmail, ready } from "@nanite/crypto";
import { createDb } from "@nanite/db";
import { InMemoryArkivWriter, type ArkivWriterPort } from "../src/arkiv/port.js";
import { createApp } from "../src/app.js";
import { acceptInboundEvent, processInboundEventById, terminalFetchFailure } from "../src/inbound/pipeline.js";
import { createInboundProcessor } from "../src/inbound/processor.js";
import { MAX_STORED_BODY_BYTES, TRUNCATION_MARKER, capBody } from "../src/inbound/classify.js";
import { RESEND_ERRORS, createFakeMailProvider, type FakeMailProvider } from "../src/mail/fake.js";
import { MAX_RECEIVED_RESPONSE_BYTES, ProviderError, createResendProvider } from "../src/mail/resend.js";
import { signSvix } from "../src/mail/svix.js";
import { provisionDevKeys, type DevKeys } from "../scripts/provision-dev-keys.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
const SECRET = "whsec_" + Buffer.from("nanite-test-webhook-secret-0002").toString("base64");
const SENDER_SECRET = "test-sender-hash-secret-0123456789";
const PREFIX = "msg_test_ri_";

const handle = createDb(DATABASE_URL, { max: 3 });
let keys: DevKeys;
let logs: string[] = [];
let provider: FakeMailProvider;
let arkiv: InMemoryArkivWriter;
let seq = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error("waitFor timed out");
}

const baseDeps = (arkivPort: ArkivWriterPort = arkiv) => ({ db: handle.db, provider, arkiv: arkivPort, senderHashSecret: SENDER_SECRET });
const log = (f: Record<string, unknown>) => void logs.push(JSON.stringify(f));

function makeApp(arkivPort: ArkivWriterPort = arkiv, sync = true) {
  const deps = baseDeps(arkivPort);
  const processor = sync ? undefined : createInboundProcessor(deps, log);
  const app = createApp({
    db: { ping: async () => void (await handle.client`select 1`) },
    webOrigin: "http://localhost:3000",
    version: "t",
    log: (l) => logs.push(l),
    inbound: { ...deps, sync, ...(processor ? { processor } : {}) },
  });
  return { app, processor };
}

function eventBody(emailId: string, to: string[] = ["alex@nanite.test"]) {
  return JSON.stringify({
    type: "email.received",
    created_at: new Date().toISOString(),
    data: { email_id: emailId, from: "Sender <sender@example.org>", to, bcc: [], cc: [], received_for: to, message_id: "<m@example.org>", subject: "s", attachments: [] },
  });
}

async function post(app: ReturnType<typeof makeApp>["app"], body: string, id = `${PREFIX}${Date.now()}_${++seq}`) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await app.request("/webhooks/resend", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signSvix(SECRET, id, timestamp, body) },
    body,
  });
  return { res, id, json: (await res.clone().json()) as Record<string, unknown> };
}

const rowOf = async (eventId: string) => {
  const [r] = await handle.client`select status, attempts, error, arkiv_entity_key from webhook_events where provider_event_id = ${eventId}`;
  return r!;
};

const decryptAgent = (w: InMemoryArkivWriter["writes"][number]) =>
  decryptEmail(w.fields, { keyId: keys.agent.keyId, publicKey: keys.agent.publicKey, privateKey: keys.agent.privateKey });

beforeAll(async () => {
  await ready();
  keys = await provisionDevKeys(handle.db);
  for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await handle.client`delete from webhook_events where provider_event_id like ${PREFIX + "%"}`;
  await handle.close();
});

beforeEach(() => {
  provider = createFakeMailProvider({ webhookSecret: SECRET });
  arkiv = new InMemoryArkivWriter();
  logs = [];
});

describe("resend provider: requests and error bodies (G3, G6, G10, G17)", () => {
  const ok = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
  function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (u: string | URL, i: RequestInit = {}) => {
      calls.push({ url: String(u), init: i });
      return handler(String(u), i);
    }) as typeof fetch;
    return { calls, provider: createResendProvider({ apiKey: "re_test_key", webhookSecret: SECRET, fetch: f }) };
  }

  it("fetches with html_format=cid and a Bearer key, and maps the documented response", async () => {
    const s = stub(() =>
      ok({ id: "em_1", to: ["a@b.c"], from: "X <x@y.z>", subject: "S", text: "T", html: '<img src="cid:logo">', headers: { "Message-ID": "<m@y.z>", References: "<r@y.z>" }, message_id: "<m@y.z>" }),
    );
    const mail = await s.provider.fetchReceived("em_1");
    expect(s.calls[0]!.url).toBe("https://api.resend.com/emails/receiving/em_1?html_format=cid");
    expect((s.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
    expect(mail).toMatchObject({ id: "em_1", text: "T", messageId: "<m@y.z>", headers: { "message-id": "<m@y.z>", references: "<r@y.z>" } });
  });

  it("getSentMessageId: GET /emails/{id} -> message_id in <...> form (bare ids get brackets, junk is null)", async () => {
    const s = stub(() => ok({ id: "em_9", message_id: "<010601a1-000000@ap-northeast-1.amazonses.com>" }));
    expect(await s.provider.getSentMessageId("em_9")).toBe("<010601a1-000000@ap-northeast-1.amazonses.com>");
    expect(s.calls[0]!.url).toBe("https://api.resend.com/emails/em_9");
    expect((s.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
    expect(await stub(() => ok({ message_id: "abc@x.example" })).provider.getSentMessageId("e")).toBe("<abc@x.example>");
    expect(await stub(() => ok({})).provider.getSentMessageId("e")).toBeNull();
    expect(await stub(() => ok({ message_id: "<a b>\r\nBcc: x" })).provider.getSentMessageId("e")).toBeNull();
    const nf = (await stub(() => new Response(JSON.stringify({ statusCode: 404, name: "not_found", message: "m" }), { status: 404 })).provider.getSentMessageId("e").catch((e) => e)) as ProviderError;
    expect(nf.detail).toEqual({ status: 404, name: "not_found" });
  });

  it("parses { statusCode, name, message } bodies: only the status, the name token and retry-after are kept", async () => {
    const body = { statusCode: 403, name: "email_above_quota", message: "SECRET-MESSAGE-TEXT" };
    const s = stub(() => new Response(JSON.stringify(body), { status: 403 }));
    const err = (await s.provider.fetchReceived("em_q").catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("provider_http_403");
    expect(err.detail).toEqual({ status: 403, name: "email_above_quota" });
    expect(JSON.stringify(err.message) + JSON.stringify(err.detail)).not.toContain("SECRET-MESSAGE");

    const rl = stub(() => new Response(JSON.stringify({ statusCode: 429, name: "rate_limit_exceeded", message: "m" }), { status: 429, headers: { "retry-after": "2" } }));
    const e2 = (await rl.provider.send({ from: "a@b.c", to: ["d@e.f"], subject: "s", text: "t" }).catch((e) => e)) as ProviderError;
    expect(e2.detail).toEqual({ status: 429, name: "rate_limit_exceeded", retryAfterMs: 2000 });

    const junk = stub(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(((await junk.provider.fetchReceived("x").catch((e) => e)) as ProviderError).detail).toEqual({ status: 502 });
    const weird = stub(() => new Response(JSON.stringify({ name: "Has Spaces & <tags>" }), { status: 400 }));
    expect(((await weird.provider.fetchReceived("x").catch((e) => e)) as ProviderError).detail).toEqual({ status: 400 });
  });

  it("network errors become provider_unreachable", async () => {
    const s = stub(() => {
      throw new TypeError("fetch failed");
    });
    expect(((await s.provider.fetchReceived("x").catch((e) => e)) as ProviderError).code).toBe("provider_unreachable");
  });

  it("refuses a received-email response over the size cap (declared and streamed) instead of buffering it", async () => {
    const declared = stub(() => new Response("{}", { status: 200, headers: { "content-length": String(MAX_RECEIVED_RESPONSE_BYTES + 1) } }));
    expect(((await declared.provider.fetchReceived("x").catch((e) => e)) as ProviderError).code).toBe("provider_response_too_large");
    const streamed = stub(() => new Response("x".repeat(MAX_RECEIVED_RESPONSE_BYTES + 10), { status: 200 }));
    expect(((await streamed.provider.fetchReceived("x").catch((e) => e)) as ProviderError).code).toBe("provider_response_too_large");
    expect(terminalFetchFailure(new ProviderError("provider_response_too_large"))).toMatchObject({ error: "response_too_large" });
  });

  it("send posts the documented body with the Idempotency-Key header", async () => {
    const s = stub(() => ok({ id: "re_123" }));
    const r = await s.provider.send({ from: "a@b.c", to: ["d@e.f"], subject: "s", text: "t", headers: { "X-A": "1" }, idempotencyKey: "key-1" });
    expect(r).toEqual({ id: "re_123" });
    const c = s.calls[0]!;
    expect(c.url).toBe("https://api.resend.com/emails");
    expect((c.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-1");
    expect(JSON.parse(String(c.init.body))).toEqual({ from: "a@b.c", to: ["d@e.f"], subject: "s", text: "t", headers: { "X-A": "1" } });
  });

  it("the fake provider serves Resend's shapes through the real provider code (G17)", async () => {
    provider = createFakeMailProvider({ webhookSecret: SECRET, emails: { em_x: { headers: { "message-id": "<q@x>" } } } });
    const mail = await provider.fetchReceived("em_x");
    expect(provider.fetchedUrls[0]).toBe("/emails/receiving/em_x?html_format=cid");
    expect(mail.headers).toEqual({ "message-id": "<q@x>" });
    expect(mail.messageId).toMatch(/^<.+>$/);
    provider.failNext("fetch", RESEND_ERRORS.emailAboveQuota);
    const err = (await provider.fetchReceived("em_y").catch((e) => e)) as ProviderError;
    expect(err.detail).toEqual({ status: 403, name: "email_above_quota" });
  });
});

describe("terminal vs retryable provider failures on fetch (G6)", () => {
  it("403 email_above_quota: dropped, 200, counts-only log, no retry storm, replay is a duplicate", async () => {
    const { app } = makeApp();
    provider.failNext("fetch", RESEND_ERRORS.emailAboveQuota);
    const first = await post(app, eventBody(`em_q_${++seq}`));
    expect(first.res.status).toBe(200);
    expect(first.json).toEqual({ status: "dropped" });
    expect(await rowOf(first.id)).toMatchObject({ status: "dropped", error: "email_above_quota" });
    expect(arkiv.writes).toHaveLength(0);
    const line = logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.code === "email_above_quota")!;
    expect(line).toMatchObject({ event: "inbound", outcome: "dropped", providerError: "email_above_quota" });
    expect(typeof line.sent).toBe("number");
    expect(typeof line.received).toBe("number");
    expect(logs.join("\n")).not.toContain("over quota when received");
    const again = await post(app, eventBody("em_q_again"), first.id);
    expect(again.json).toEqual({ status: "duplicate" });
    expect(provider.fetched).toHaveLength(1);
  });

  it.each([
    ["401 restricted_api_key", RESEND_ERRORS.restrictedKey401, "restricted_api_key"],
    ["403 restricted_api_key", RESEND_ERRORS.restrictedKey403, "restricted_api_key"],
    ["401 validation_error (bad key)", RESEND_ERRORS.invalidKey, "validation_error"],
  ])("%s: terminal, 200, logged as a config error with the name only; a replay after fixing the key stores it", async (_n, failure, name) => {
    const { app } = makeApp();
    provider.failNext("fetch", failure);
    const first = await post(app, eventBody(`em_cfg_${++seq}`));
    expect(first.res.status).toBe(200);
    expect(first.json).toEqual({ status: "dropped" });
    expect(await rowOf(first.id)).toMatchObject({ status: "dropped", error: "provider_config_error" });
    const line = logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.code === "provider_config_error")!;
    expect(line).toMatchObject({ level: "error", providerError: name });
    expect(JSON.stringify(line)).not.toContain("restricted to only send");
    // key fixed -> Resend/Vikrant replays the same message: it is processed, not swallowed as a duplicate
    const replay = await post(app, eventBody("em_cfg_replay"), first.id);
    expect(replay.json).toEqual({ status: "stored" });
    expect(arkiv.writes).toHaveLength(1);
  });

  it("other 4xx (e.g. 422) are terminal too; 404/408/429 are retryable", () => {
    expect(terminalFetchFailure(new ProviderError("provider_http_422", { status: 422, name: "invalid_parameter" }))).toMatchObject({ error: "provider_http_422" });
    for (const status of [404, 408, 425, 429, 500, 503]) expect(terminalFetchFailure(new ProviderError(`provider_http_${status}`, { status }))).toBeNull();
    expect(terminalFetchFailure(new ProviderError("provider_unreachable"))).toBeNull();
    expect(terminalFetchFailure(new Error("x"))).toBeNull();
  });

  it.each([
    ["500 application_error", RESEND_ERRORS.applicationError, "provider_http_500"],
    ["503 service_unavailable", RESEND_ERRORS.unavailable, "provider_http_503"],
    ["429 rate_limit_exceeded", RESEND_ERRORS.rateLimit, "provider_http_429"],
    ["network error", RESEND_ERRORS.network, "provider_unreachable"],
  ])("%s stays retryable: 500 so the provider retries, and the retry stores it", async (_n, failure, code) => {
    const { app } = makeApp();
    provider.failNext("fetch", failure);
    const body = eventBody(`em_retry_${++seq}`);
    const first = await post(app, body);
    expect(first.res.status).toBe(500);
    expect(await rowOf(first.id)).toMatchObject({ status: "failed", error: code });
    const retry = await post(app, body, first.id);
    expect(retry.json).toEqual({ status: "stored" });
    expect(arkiv.writes).toHaveLength(1);
  });
});

describe("stored body size and html (G3, decision: inbound text only)", () => {
  it("cuts a huge text body at 64 KiB on a character boundary with a marker and still stores it", async () => {
    const emailId = `em_big_${++seq}`;
    provider = createFakeMailProvider({ webhookSecret: SECRET, emails: { [emailId]: { text: "é".repeat(100_000), subject: "x".repeat(2000) } } });
    const { app } = makeApp();
    const r = await post(app, eventBody(emailId));
    expect(r.json).toEqual({ status: "stored" });
    const plain = await decryptAgent(arkiv.writes[0]!);
    expect(plain.body.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(plain.body)).toBeLessThanOrEqual(MAX_STORED_BODY_BYTES + Buffer.byteLength(TRUNCATION_MARKER));
    expect(plain.body).not.toContain("�");
    expect(plain.subject.length).toBe(998);
    expect(provider.fetchedUrls[0]).toBe(`/emails/receiving/${emailId}?html_format=cid`);
  });

  it("capBody leaves short text alone and never splits a character", () => {
    expect(capBody("hello")).toEqual({ text: "hello", truncated: false });
    const cut = capBody("a€b€c€", 5); // "a" + one 3-byte char = 4 bytes, the next char would end at byte 8
    expect(cut.truncated).toBe(true);
    expect(cut.text.startsWith("a€")).toBe(true);
    expect(cut.text).not.toContain("�");
  });

  it("an html-only mail is stored as stripped text; the html itself is never stored", async () => {
    const emailId = `em_html_${++seq}`;
    provider = createFakeMailProvider({
      webhookSecret: SECRET,
      emails: { [emailId]: { text: null, html: '<html><body><p>Hello <b>world</b></p><img src="cid:logo"><a href="https://example.com/x">link</a></body></html>' } },
    });
    const { app } = makeApp();
    expect((await post(app, eventBody(emailId))).json).toEqual({ status: "stored" });
    const plain = await decryptAgent(arkiv.writes[0]!);
    expect(plain.body).toContain("Hello world");
    expect(plain.body).not.toContain("<");
    expect(JSON.stringify(plain)).not.toContain("cid:logo");
    expect(plain.meta?.links).toEqual(["https://example.com/x"]);
  });
});

describe("async webhook: early 200, background processing, crash recovery", () => {
  it("answers 200 while the Arkiv write is still blocked, then stores in the background exactly once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: ArkivWriterPort = { writeEmail: async (i) => (await gate, arkiv.writeEmail(i)) };
    const { app, processor } = makeApp(slow, false);
    const body = eventBody(`em_async_${++seq}`);

    const t0 = Date.now();
    const first = await post(app, body);
    expect(Date.now() - t0).toBeLessThan(1500); // would never return: the writer is blocked on `gate`
    expect(first.res.status).toBe(200);
    expect(first.json).toEqual({ status: "accepted" });
    expect(arkiv.writes).toHaveLength(0);

    await waitFor(async () => (await rowOf(first.id)).status === "processing");
    const dup = await post(app, body, first.id); // Resend redelivers while we are busy
    expect(dup.json).toEqual({ status: "duplicate" });

    release();
    await processor!.idle();
    expect(await rowOf(first.id)).toMatchObject({ status: "stored", error: null });
    expect(arkiv.writes).toHaveLength(1);
    expect(provider.fetched).toHaveLength(1);
    expect((await post(app, body, first.id)).json).toEqual({ status: "duplicate" });
    expect(arkiv.writes).toHaveLength(1);
  });

  it("drops unknown recipients and ignores other events without any background work", async () => {
    const { app } = makeApp(arkiv, false);
    const unknown = await post(app, eventBody(`em_nobody_${++seq}`, ["nobody@nanite.test"]));
    expect(unknown.json).toEqual({ status: "dropped" });
    expect(await rowOf(unknown.id)).toMatchObject({ status: "dropped", error: "no_active_mailbox" });
    expect((await post(app, JSON.stringify({ type: "email.sent", data: {} }))).json).toEqual({ status: "ignored" });
    expect(provider.fetched).toHaveLength(0);
    const bad = await app.request("/webhooks/resend", { method: "POST", headers: { "svix-id": "x", "svix-timestamp": "1", "svix-signature": "v1,AAAA" }, body: "{}" });
    expect(bad.status).toBe(401);
  });

  it("a background failure is recorded as failed (no content), and the periodic sweep retries it with bounded attempts", async () => {
    let fail = true;
    const flaky: ArkivWriterPort = { writeEmail: async (i) => (fail ? Promise.reject(Object.assign(new Error("boom"), { name: "ArkivWriteError" })) : arkiv.writeEmail(i)) };
    const { app, processor } = makeApp(flaky, false);
    const first = await post(app, eventBody(`em_bg_fail_${++seq}`));
    expect(first.res.status).toBe(200);
    await processor!.idle();
    expect(await rowOf(first.id)).toMatchObject({ status: "failed", error: "arkiv_write_failed", attempts: 1 });

    // Too young for the periodic sweep ...
    const prefix = first.id;
    expect(await processor!.sweep({ eventIdPrefix: prefix })).toBe(0);
    // ... eligible 10 minutes later. Keeps failing until the attempts are used up (5), then it is left alone.
    const later = createInboundProcessor({ ...baseDeps(flaky), now: () => new Date(Date.now() + 10 * 60_000) }, log);
    for (let i = 2; i <= 5; i++) {
      expect(await later.sweep({ eventIdPrefix: prefix })).toBe(1);
      await later.idle();
      expect(await rowOf(first.id)).toMatchObject({ status: "failed", attempts: i });
    }
    expect(await later.sweep({ eventIdPrefix: prefix })).toBe(0);
    expect(arkiv.writes).toHaveLength(0);

    // A fresh event that fails once and then succeeds is stored by the sweep.
    const second = await post(app, eventBody(`em_bg_ok_${++seq}`));
    await processor!.idle();
    expect((await rowOf(second.id)).status).toBe("failed");
    fail = false;
    const later2 = createInboundProcessor({ ...baseDeps(flaky), now: () => new Date(Date.now() + 10 * 60_000) }, log);
    expect(await later2.sweep({ eventIdPrefix: second.id })).toBe(1);
    await later2.idle();
    expect(await rowOf(second.id)).toMatchObject({ status: "stored" });
    expect(arkiv.writes).toHaveLength(1);
  });

  it("crash after accept: the startup sweep of a restarted process stores the event once", async () => {
    const deps = baseDeps();
    const ev = { kind: "received" as const, providerEventId: `${PREFIX}crash_${++seq}`, emailId: `em_crash_${seq}`, recipients: ["alex@nanite.test"] };
    expect(await acceptInboundEvent(deps, ev, log)).toMatchObject({ status: "accepted" }); // ... and the process dies here
    expect(await rowOf(ev.providerEventId)).toMatchObject({ status: "received", attempts: 0 });
    const [led] = await handle.client`select a.status from arkiv_writes a join webhook_events e on e.id = a.webhook_event_id where e.provider_event_id = ${ev.providerEventId}`;
    expect(led!.status).toBe("queued");
    expect(arkiv.writes).toHaveLength(0);

    const restarted = createInboundProcessor(deps, log);
    expect(await restarted.sweep({ startup: true, eventIdPrefix: ev.providerEventId })).toBe(1);
    await restarted.idle();
    expect(await rowOf(ev.providerEventId)).toMatchObject({ status: "stored", attempts: 1 });
    expect(arkiv.writes).toHaveLength(1);
    expect(await restarted.sweep({ startup: true, eventIdPrefix: ev.providerEventId })).toBe(0);
    expect(arkiv.writes).toHaveLength(1);
  });

  it("crash while processing: only the startup sweep reclaims a young `processing` row", async () => {
    const deps = baseDeps();
    const ev = { kind: "received" as const, providerEventId: `${PREFIX}mid_${++seq}`, emailId: `em_mid_${seq}`, recipients: ["alex@nanite.test"] };
    await acceptInboundEvent(deps, ev, log);
    await handle.client`update webhook_events set status = 'processing', attempts = 1 where provider_event_id = ${ev.providerEventId}`;
    const p = createInboundProcessor(deps, log);
    expect(await p.sweep({ eventIdPrefix: ev.providerEventId })).toBe(0); // another live worker might own it
    expect(await p.sweep({ startup: true, eventIdPrefix: ev.providerEventId })).toBe(1);
    await p.idle();
    expect(await rowOf(ev.providerEventId)).toMatchObject({ status: "stored", attempts: 2 });
    expect(arkiv.writes).toHaveLength(1);
  });

  it("crash after the Arkiv write but before the event was finished: no second entity, no second fetch", async () => {
    const deps = baseDeps();
    const ev = { kind: "received" as const, providerEventId: `${PREFIX}late_${++seq}`, emailId: `em_late_${seq}`, recipients: ["alex@nanite.test"] };
    await acceptInboundEvent(deps, ev, log);
    const [row] = await handle.client`select id from webhook_events where provider_event_id = ${ev.providerEventId}`;
    expect((await processInboundEventById(deps, row!.id as string, log)).status).toBe("stored");
    const key = (await rowOf(ev.providerEventId)).arkiv_entity_key;
    // the process died between the ledger update and the event update:
    await handle.client`update webhook_events set status = 'processing', arkiv_entity_key = null where id = ${row!.id as string}`;
    const restarted = createInboundProcessor(deps, log);
    expect(await restarted.sweep({ startup: true, eventIdPrefix: ev.providerEventId })).toBe(1);
    await restarted.idle();
    expect(await rowOf(ev.providerEventId)).toMatchObject({ status: "stored", arkiv_entity_key: key });
    expect(arkiv.writes).toHaveLength(1);
    expect(provider.fetched).toHaveLength(1);
  });

  it("the same event queued twice (route + sweep) is processed once", async () => {
    const deps = baseDeps();
    const ev = { kind: "received" as const, providerEventId: `${PREFIX}twice_${++seq}`, emailId: `em_twice_${seq}`, recipients: ["alex@nanite.test"] };
    const acc = await acceptInboundEvent(deps, ev, log);
    if (acc.status !== "accepted") throw new Error("expected accepted");
    const a = createInboundProcessor(deps, log);
    const b = createInboundProcessor(deps, log); // e.g. the route's processor and a second one
    a.enqueue(acc.eventRowId);
    a.enqueue(acc.eventRowId);
    b.enqueue(acc.eventRowId);
    await Promise.all([a.idle(), b.idle()]);
    expect(arkiv.writes).toHaveLength(1);
    expect(provider.fetched).toHaveLength(1);
    expect((await rowOf(ev.providerEventId)).status).toBe("stored");
  });
});
