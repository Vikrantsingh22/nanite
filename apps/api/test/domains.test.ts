import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateNaniteSeed, generateSalt, generateUserKeypair, keyId, ready, wrapSecret } from "@nanite/crypto";
import { createDb, domains, findMailboxByAddress, getUserDomain, mailboxes, userDomains, users } from "@nanite/db";
import { eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import type { AgentChain, AgentEvent } from "../src/agents/chain.js";
import { InMemoryArkivWriter } from "../src/arkiv/port.js";
import { createApp } from "../src/app.js";
import { answerMatches, createDohResolver, detectProvider, normalizeAnswer } from "../src/domains/dns.js";
import { createFakeDns, createFakeResendDomains, sampleRecords } from "../src/domains/fake.js";
import { isSameOrSubdomain, normalizeDomain, recordFqdn, registrableDomain, zoneRelativeHost } from "../src/domains/hostname.js";
import { ResendDomainError, classifyDomainError, createResendDomains } from "../src/domains/resend-domains.js";
import { createDomainService } from "../src/domains/service.js";
import { createDomainVerifier } from "../src/domains/verifier.js";
import { checkDelayMs } from "../src/domains/view.js";
import { createFakeMailProvider } from "../src/mail/fake.js";
import { signSvix } from "../src/mail/svix.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
const ORIGIN = "http://localhost:3000";
const SECRET = "whsec_" + Buffer.from("nanite-test-webhook-secret-0001").toString("base64");
const SHARED = "shared-t36.nanite.test";
const SFX = randomBytes(3).toString("hex");
const handle = createDb(DATABASE_URL, { max: 3 });
const masterKey = new Uint8Array(randomBytes(32));

let clock = new Date();
let logs: string[] = [];
let resend = createFakeResendDomains();
let dns = createFakeDns();
let creates: Array<{ email: string; agentLabel: string }> = [];

const chain = {
  canWrite: true,
  async createAgentName(a: { email: string; agentLabel: string; username: string }, on: (e: AgentEvent) => void) {
    on({ step: "deploy-resolver", phase: "done", txHash: "0xaaa" });
    creates.push({ email: a.email, agentLabel: a.agentLabel });
    return { name: `${a.agentLabel}.${a.username}.nanitecom.eth`, resolver: `0x${"ab".repeat(20)}` };
  },
  async publishSigner() {},
} as unknown as AgentChain;

function services() {
  const service = createDomainService({
    db: handle.db,
    resend,
    dns,
    defaultRegion: "ap-northeast-1",
    reservedDomains: ["nanitecom.itsvikrant.tech", SHARED],
    log: (l) => logs.push(l),
    now: () => clock,
  });
  return { service, verifier: createDomainVerifier({ db: handle.db, service, log: (l) => logs.push(l), now: () => clock }) };
}
let svc = services();

function makeApp() {
  return createApp({
    db: { ping: async () => void (await handle.client`select 1`) },
    webOrigin: ORIGIN,
    version: "t",
    log: (l) => logs.push(l),
    auth: { db: handle.db, chainIds: [11155111], secureCookie: false },
    agents: { chain, masterKey, sharedMailDomain: SHARED },
    domains: svc.service,
    inbound: {
      db: handle.db,
      provider: createFakeMailProvider({ webhookSecret: SECRET }),
      arkiv: new InMemoryArkivWriter(),
      senderHashSecret: "test-sender-hash-secret-0123456789",
      sync: true,
    },
  });
}
let app = makeApp();

const userIds: string[] = [];
beforeAll(() => ready());
afterAll(async () => {
  if (userIds.length > 0) {
    await handle.db.delete(mailboxes).where(inArray(mailboxes.userId, userIds));
    await handle.db.delete(users).where(inArray(users.id, userIds));
  }
  await handle.db.delete(domains).where(eq(domains.name, SHARED));
  await handle.close();
});
beforeEach(async () => {
  // Rows of earlier tests point at ids of an earlier fake Resend: drop them so the verifier only sees this test's data.
  if (userIds.length > 0) await handle.db.delete(userDomains).where(inArray(userDomains.userId, userIds));
  clock = new Date();
  logs = [];
  resend = createFakeResendDomains();
  resend.limit = 100;
  dns = createFakeDns();
  creates = [];
  svc = services();
  app = makeApp();
});

const call = (cookie: string, path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { cookie, origin: ORIGIN, "content-type": "application/json", ...(init.headers ?? {}) } });
const post = (cookie: string, path: string, body?: unknown) => call(cookie, path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (r: Response) => (await r.json()) as Record<string, any>;

async function bundle() {
  const kp = await generateUserKeypair();
  const seed = await generateNaniteSeed();
  const k1 = new Uint8Array(32).fill(1);
  const k2 = new Uint8Array(32).fill(2);
  const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
  return {
    publicKey: b64(kp.publicKey),
    keyId: keyId(kp.publicKey),
    walletSalt: b64(await generateSalt()),
    recoverySalt: b64(await generateSalt()),
    wrappedPrivateKeyWallet: b64(await wrapSecret(kp.privateKey, k1)),
    wrappedPrivateKeyRecovery: b64(await wrapSecret(kp.privateKey, k2)),
    wrappedSeedWallet: b64(await wrapSecret(seed, k1)),
    wrappedSeedRecovery: b64(await wrapSecret(seed, k2)),
    passphraseMode: false,
  };
}

let counter = 0;
/** A signed-in user with keys and a claimed username, in the given onboarding state. */
async function makeUser(state: "name_claimed" | "done" = "name_claimed") {
  const account = privateKeyToAccount(generatePrivateKey());
  const nonce = ((await (await app.request("/auth/nonce")).json()) as { nonce: string }).nonce;
  const message = createSiweMessage({ address: account.address, chainId: 11155111, domain: "localhost:3000", nonce, uri: ORIGIN, version: "1", statement: "Sign in to Nanite" });
  const signature = await account.signMessage({ message });
  const res = await app.request("/auth/verify", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ message, signature }) });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect((await post(cookie, "/onboarding/keys", await bundle())).status).toBe(201);
  const username = `dm${SFX}${counter++}`;
  const wallet = account.address.toLowerCase();
  const [row] = await handle.db.update(users).set({ username, ensName: `${username}.nanitecom.eth`, onboardingState: state }).where(eq(users.walletAddress, wallet)).returning();
  userIds.push(row!.id);
  return { cookie, id: row!.id, username };
}

const domainName = (label = "mail") => `${label}-${SFX}${counter++}.example.com`;

async function addDomain(u: { cookie: string }, name = domainName()) {
  const res = await post(u.cookie, "/onboarding/domain", { name });
  expect([200, 201]).toContain(res.status);
  return { name, view: await json(res) };
}

/** Marks the user's domain verified the way Resend would (fake status + a check). */
async function verifyFor(u: { id: string }) {
  const row = (await getUserDomain(handle.db, u.id))!;
  resend.setStatus(row.resendDomainId, "verified");
  await svc.service.runCheck(row);
}

// ---------------------------------------------------------------- pure helpers

describe("hostnames", () => {
  it("normalizes what users paste", () => {
    expect(normalizeDomain("  HTTPS://Mail.Example.COM/path?x=1#y ")).toEqual({ ok: true, name: "mail.example.com" });
    expect(normalizeDomain("mail.example.com.")).toEqual({ ok: true, name: "mail.example.com" });
    expect(normalizeDomain("me@example.com")).toEqual({ ok: true, name: "example.com" });
    expect(normalizeDomain("example.com:8080")).toEqual({ ok: true, name: "example.com" });
    expect(normalizeDomain("bücher.example")).toEqual({ ok: true, name: "xn--bcher-kva.example" });
  });
  it("rejects things that are not hostnames", () => {
    for (const bad of ["", "localhost", "-a.example.com", "a..example.com", "exa mple.com", "1.2.3.4", "example.123", "a".repeat(64) + ".com", undefined, 5, "https://"]) {
      expect(normalizeDomain(bad as unknown).ok, String(bad)).toBe(false);
    }
  });
  it("finds the registrable domain, including two-level suffixes", () => {
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("mail.example.com")).toBe("example.com");
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
    expect(registrableDomain("example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("mail.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("mail.example.co.in")).toBe("example.co.in");
    expect(registrableDomain("x.example.com.au")).toBe("example.com.au");
    expect(registrableDomain("nanitecom.itsvikrant.tech")).toBe("itsvikrant.tech");
  });
  it("computes zone-relative hosts", () => {
    expect(zoneRelativeHost("nanitecom.itsvikrant.tech", "itsvikrant.tech", "send.nanitecom")).toBe("send.nanitecom");
    expect(zoneRelativeHost("nanitecom.itsvikrant.tech", "itsvikrant.tech", "resend._domainkey.nanitecom")).toBe("resend._domainkey.nanitecom");
    expect(zoneRelativeHost("nanitecom.itsvikrant.tech", "itsvikrant.tech", "nanitecom")).toBe("nanitecom");
    // names relative to the domain itself get the domain's label appended
    expect(zoneRelativeHost("nanitecom.itsvikrant.tech", "itsvikrant.tech", "send")).toBe("send.nanitecom");
    expect(zoneRelativeHost("nanitecom.itsvikrant.tech", "itsvikrant.tech", "@")).toBe("nanitecom");
    // apex
    expect(zoneRelativeHost("example.com", "example.com", "send")).toBe("send");
    expect(zoneRelativeHost("example.com", "example.com", "@")).toBe("@");
    // two-level TLD
    expect(zoneRelativeHost("mail.example.co.uk", "example.co.uk", "send.mail")).toBe("send.mail");
    expect(recordFqdn("send.mail", "example.co.uk")).toBe("send.mail.example.co.uk");
    expect(recordFqdn("@", "example.com")).toBe("example.com");
    expect(isSameOrSubdomain("a.nanitecom.itsvikrant.tech", "nanitecom.itsvikrant.tech")).toBe(true);
    expect(isSameOrSubdomain("xnanitecom.itsvikrant.tech", "nanitecom.itsvikrant.tech")).toBe(false);
  });
  it("has the documented backoff schedule", () => {
    const s = 1000;
    expect(checkDelayMs(0)).toBe(15 * s);
    expect(checkDelayMs(10 * 60 * s - 1)).toBe(15 * s);
    expect(checkDelayMs(10 * 60 * s)).toBe(120 * s);
    expect(checkDelayMs(2 * 3600 * s - 1)).toBe(120 * s);
    expect(checkDelayMs(2 * 3600 * s)).toBe(900 * s);
    expect(checkDelayMs(72 * 3600 * s - 1)).toBe(900 * s);
    expect(checkDelayMs(72 * 3600 * s)).toBeNull();
  });
});

describe("dns helpers", () => {
  it("parses DoH answers, joins split TXT strings, maps NXDOMAIN and failures", async () => {
    const mk = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;
    const txt = createDohResolver({ fetch: mk({ Status: 0, Answer: [{ type: 16, data: '"p=AAAA" "BBBB"' }, { type: 5, data: "x." }] }) });
    expect(await txt.query("a.example.com", "TXT")).toEqual(["p=AAAABBBB"]);
    const mx = createDohResolver({ fetch: mk({ Status: 0, Answer: [{ type: 15, data: "10 Receive.Example.NET." }] }) });
    expect(await mx.query("a.example.com", "MX")).toEqual(["10 receive.example.net"]);
    expect(await createDohResolver({ fetch: mk({ Status: 3 }) }).query("nx.example.com", "MX")).toEqual([]);
    expect(await createDohResolver({ fetch: mk({ Status: 2 }) }).query("a.example.com", "MX")).toBeNull();
    expect(await createDohResolver({ fetch: mk({}, false) }).query("a.example.com", "MX")).toBeNull();
    const boom = createDohResolver({ fetch: (async () => { throw new Error("net"); }) as unknown as typeof fetch });
    expect(await boom.query("a.example.com", "MX")).toBeNull();
  });
  it("asks Cloudflare for application/dns-json", async () => {
    let seen: { url: string; accept: string | null } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, accept: new Headers(init.headers).get("accept") };
      return new Response(JSON.stringify({ Status: 0, Answer: [] }));
    }) as unknown as typeof fetch;
    await createDohResolver({ fetch: f }).query("example.com", "NS");
    expect(seen!.url).toBe("https://cloudflare-dns.com/dns-query?name=example.com&type=NS");
    expect(seen!.accept).toBe("application/dns-json");
  });
  it("matches record values", () => {
    expect(answerMatches("TXT", '"v=spf1 include:amazonses.com ~all"', ["v=spf1 include:amazonses.com ~all"])).toBe(true);
    expect(answerMatches("TXT", "p=ABC DEF", ["p=ABCDEF"])).toBe(true);
    expect(answerMatches("TXT", "p=ABC", ["p=XYZ"])).toBe(false);
    expect(answerMatches("CNAME", "send.forge.rmta.net", ["send.forge.rmta.net"])).toBe(true);
    expect(answerMatches("MX", "feedback-smtp.ap-northeast-1.amazonses.com", ["10 feedback-smtp.ap-northeast-1.amazonses.com"])).toBe(true);
    expect(answerMatches("MX", "a.example.net", ["10 b.example.net"])).toBe(false);
    expect(normalizeAnswer("NS", "Ns1.Example.COM.")).toBe("ns1.example.com");
  });
  it("detects the DNS provider", () => {
    expect(detectProvider(["abby.ns.cloudflare.com"])).toBe("cloudflare");
    expect(detectProvider(["ns51.domaincontrol.com"])).toBe("godaddy");
    expect(detectProvider(["dns1.registrar-servers.com"])).toBe("namecheap");
    expect(detectProvider(["ns-123.awsdns-45.com"])).toBe("route53");
    expect(detectProvider(["ns-cloud-a1.googledomains.com"])).toBe("google");
    expect(detectProvider(["ns1.example.net"])).toBe("other");
    expect(detectProvider([])).toBe("other");
  });
  it("classifies Resend errors", () => {
    expect(classifyDomainError(new ResendDomainError(403, "validation_error", "You have reached the limit of domains"))).toBe("limit");
    expect(classifyDomainError(new ResendDomainError(403, "domain_limit_reached", ""))).toBe("limit");
    expect(classifyDomainError(new ResendDomainError(401, "restricted_api_key", ""))).toBe("key");
    expect(classifyDomainError(new ResendDomainError(403, "validation_error", "domain registered already"))).toBe("taken");
    expect(classifyDomainError(new ResendDomainError(422, "validation_error", "bad name"))).toBe("invalid");
    expect(classifyDomainError(new ResendDomainError(404, "not_found", ""))).toBe("not_found");
    expect(classifyDomainError(new ResendDomainError(500, undefined, ""))).toBe("unavailable");
    expect(classifyDomainError(new Error("x"))).toBe("unavailable");
  });
});

// ---------------------------------------------------------------- routes

describe("auth", () => {
  it("requires a session and the allowed Origin", async () => {
    expect((await app.request("/onboarding/domain")).status).toBe(401);
    expect((await app.request("/onboarding/domain/check", { method: "POST", body: "{}" })).status).toBe(401);
    const u = await makeUser();
    const bad = await app.request("/onboarding/domain", { method: "POST", headers: { cookie: u.cookie, origin: "http://evil.example", "content-type": "application/json" }, body: JSON.stringify({ name: domainName() }) });
    expect(bad.status).toBe(403);
    expect(resend.calls).toHaveLength(0);
  });
  it("answers 503 resend_not_configured when the service is absent", async () => {
    const bare = createApp({ db: { ping: async () => undefined }, webOrigin: ORIGIN, version: "t", log: () => undefined, auth: { db: handle.db, chainIds: [11155111], secureCookie: false } });
    const u = await makeUser();
    const res = await bare.request("/onboarding/domain", { headers: { cookie: u.cookie } });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe("resend_not_configured");
  });
});

describe("POST /onboarding/domain/check", () => {
  it("normalizes, detects the provider and suggests a subdomain for an apex with MX", async () => {
    const u = await makeUser();
    const root = `${SFX}check1.com`;
    dns.set(root, "MX", ["10 mx.google.com"]);
    dns.set(root, "NS", ["abby.ns.cloudflare.com", "bob.ns.cloudflare.com"]);
    const res = await post(u.cookie, "/onboarding/domain/check", { name: `HTTPS://${root.toUpperCase()}./` });
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b).toMatchObject({ name: root, root, suggestion: `mail.${root}`, rootHasMx: true, provider: "cloudflare" });
    expect(b.warnings.join(" ")).toMatch(/already receives mail/);
    expect(resend.calls).toHaveLength(0); // checking never touches Resend
  });
  it("allows an apex without MX but still suggests a subdomain", async () => {
    const u = await makeUser();
    const root = `${SFX}check2.com`;
    const b = await json(await post(u.cookie, "/onboarding/domain/check", { name: root }));
    expect(b).toMatchObject({ name: root, rootHasMx: false, suggestion: `mail.${root}`, provider: "other" });
    expect(b.warnings.join(" ")).toMatch(/Best practice/);
  });
  it("gives no suggestion for a subdomain, and warns when it already has MX", async () => {
    const u = await makeUser();
    const root = `${SFX}check3.co.uk`;
    dns.set(`mail.${root}`, "MX", ["10 old.example.net"]);
    const b = await json(await post(u.cookie, "/onboarding/domain/check", { name: `mail.${root}` }));
    expect(b.root).toBe(root);
    expect(b.suggestion).toBeUndefined();
    expect(b.warnings.join(" ")).toMatch(/already has MX/);
  });
  it("refuses invalid names, the platform domain and its subdomains, and taken domains", async () => {
    const a = await makeUser();
    const b = await makeUser();
    expect((await post(a.cookie, "/onboarding/domain/check", { name: "not a domain" })).status).toBe(400);
    expect((await post(a.cookie, "/onboarding/domain/check", {})).status).toBe(400);
    for (const n of ["nanitecom.itsvikrant.tech", "foo.nanitecom.itsvikrant.tech", "NANITECOM.itsvikrant.tech.", SHARED]) {
      const res = await post(a.cookie, "/onboarding/domain/check", { name: n });
      expect(res.status, n).toBe(400);
      expect((await json(res)).error).toBe("domain_reserved");
    }
    const { name } = await addDomain(a);
    const taken = await post(b.cookie, "/onboarding/domain/check", { name });
    expect(taken.status).toBe(409);
    expect((await json(taken)).error).toBe("domain_taken");
    // the owner may check their own domain again
    expect((await post(a.cookie, "/onboarding/domain/check", { name })).status).toBe(200);
  });
});

describe("POST /onboarding/domain", () => {
  it("creates the domain in Resend with the default region and returns the view", async () => {
    const u = await makeUser();
    const name = domainName();
    const res = await post(u.cookie, "/onboarding/domain", { name: name.toUpperCase() });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const v = await json(res);
    expect(resend.calls.filter((c) => c.op === "create")).toEqual([{ op: "create", arg: { name, region: "ap-northeast-1" } }]);
    expect(v).toMatchObject({ name, zone: registrableDomain(name), status: "not_started", region: "ap-northeast-1", provider: "other", verifiedAt: null });
    expect(v.providerTips.length).toBeGreaterThan(0);
    expect(v.records).toHaveLength(5);
    const rec = v.records.find((r: any) => r.type === "CNAME");
    expect(rec).toMatchObject({ purpose: "SPF CNAME", host: `rsend.${name.split(".")[0]}`, value: "send.forge.rmta.net", resendStatus: "not_started", dnsFound: false });
    expect(rec.fqdn).toBe(`${rec.host}.${registrableDomain(name)}`);
    const mx = v.records.find((r: any) => r.purpose === "Receiving");
    expect(mx).toMatchObject({ type: "MX", priority: 10, host: name.split(".")[0] });
    expect(v.nextCheckAt).not.toBeNull();
  });
  it("is idempotent for the same name and refuses a different one", async () => {
    const u = await makeUser();
    const { name } = await addDomain(u);
    const again = await post(u.cookie, "/onboarding/domain", { name });
    expect(again.status).toBe(200);
    expect(resend.calls.filter((c) => c.op === "create")).toHaveLength(1);
    const other = await post(u.cookie, "/onboarding/domain", { name: domainName() });
    expect(other.status).toBe(409);
    expect((await json(other)).error).toBe("domain_exists");
    expect(resend.calls.filter((c) => c.op === "create")).toHaveLength(1);
  });
  it("adopts a domain that already exists in the Resend account", async () => {
    const u = await makeUser();
    const name = domainName();
    const existing = resend.seed(name, "eu-west-1");
    const res = await post(u.cookie, "/onboarding/domain", { name });
    expect(res.status).toBe(201);
    expect(resend.calls.some((c) => c.op === "create")).toBe(false);
    expect((await getUserDomain(handle.db, u.id))?.resendDomainId).toBe(existing.id);
    expect((await json(res)).region).toBe("eu-west-1");
  });
  it("honours a valid region and rejects an invalid one", async () => {
    const u = await makeUser();
    expect((await post(u.cookie, "/onboarding/domain", { name: domainName(), region: "mars-1" })).status).toBe(400);
    const name = domainName();
    expect((await post(u.cookie, "/onboarding/domain", { name, region: "eu-west-1" })).status).toBe(201);
    expect(resend.calls.find((c) => c.op === "create")?.arg).toEqual({ name, region: "eu-west-1" });
  });
  it("maps Resend errors: limit 409, invalid 400, key 503, unavailable 502", async () => {
    const u = await makeUser();
    resend.limit = 0;
    const limit = await post(u.cookie, "/onboarding/domain", { name: domainName() });
    expect(limit.status).toBe(409);
    const lb = await json(limit);
    expect(lb.error).toBe("domain_limit_reached");
    expect(lb.message).toMatch(/no free domain slot/);
    expect(await getUserDomain(handle.db, u.id)).toBeNull();
    resend.limit = 100;
    resend.failNext("create", new ResendDomainError(422, "validation_error", "bad"));
    expect((await post(u.cookie, "/onboarding/domain", { name: domainName() })).status).toBe(400);
    resend.failNext("create", new ResendDomainError(401, "restricted_api_key", ""));
    const key = await post(u.cookie, "/onboarding/domain", { name: domainName() });
    expect(key.status).toBe(503);
    expect((await json(key)).error).toBe("resend_not_configured");
    resend.failNext("list", new ResendDomainError(500, undefined, ""));
    expect((await post(u.cookie, "/onboarding/domain", { name: domainName() })).status).toBe(502);
  });
  it("refuses reserved and taken names without calling Resend", async () => {
    const a = await makeUser();
    const b = await makeUser();
    expect((await post(a.cookie, "/onboarding/domain", { name: "send.nanitecom.itsvikrant.tech" })).status).toBe(400);
    const { name } = await addDomain(a);
    const calls = resend.calls.length;
    expect((await post(b.cookie, "/onboarding/domain", { name })).status).toBe(409);
    expect(resend.calls.length).toBe(calls);
  });
});

describe("GET /onboarding/domain and ownership", () => {
  it("404s before a domain exists and is invisible to other users", async () => {
    const a = await makeUser();
    const b = await makeUser();
    expect((await call(a.cookie, "/onboarding/domain")).status).toBe(404);
    const { name } = await addDomain(a);
    const mine = await json(await call(a.cookie, "/onboarding/domain"));
    expect(mine.name).toBe(name);
    expect((await call(b.cookie, "/onboarding/domain")).status).toBe(404);
    expect((await post(b.cookie, "/onboarding/domain/verify")).status).toBe(404);
    expect((await call(b.cookie, "/onboarding/domain", { method: "DELETE" })).status).toBe(404);
    expect(await getUserDomain(handle.db, a.id)).not.toBeNull();
  });
  it("reports per-record DNS state", async () => {
    const u = await makeUser();
    const { name, view } = await addDomain(u);
    expect(view.records.every((r: any) => r.dnsFound === false)).toBe(true);
    const row = (await getUserDomain(handle.db, u.id))!;
    const remote = await resend.getDomain(row.resendDomainId);
    dns.publish(name, remote.records.filter((r) => r.type === "TXT"));
    await svc.service.runCheck(row);
    const v = await json(await call(u.cookie, "/onboarding/domain"));
    expect(v.records.filter((r: any) => r.dnsFound).map((r: any) => r.type).sort()).toEqual(["TXT", "TXT"]);
    expect(v.records.filter((r: any) => !r.dnsFound)).toHaveLength(3);
    expect(v.lastCheckedAt).toBe(clock.toISOString());
    // a failed lookup is unknown, not "missing"
    dns.failing.add(recordFqdn(v.records[0].host, v.zone));
    await svc.service.runCheck((await getUserDomain(handle.db, u.id))!);
    const v2 = await json(await call(u.cookie, "/onboarding/domain"));
    expect(v2.records[0].dnsFound).toBeNull();
  });
});

describe("POST /onboarding/domain/verify", () => {
  it("runs a check, asks Resend to verify, and is limited to once per 30 s", async () => {
    const u = await makeUser();
    await addDomain(u);
    const res = await post(u.cookie, "/onboarding/domain/verify");
    expect(res.status).toBe(200);
    expect(resend.calls.filter((c) => c.op === "verify")).toHaveLength(1);
    expect((await json(res)).status).toBe("pending");
    const limited = await post(u.cookie, "/onboarding/domain/verify");
    expect(limited.status).toBe(429);
    const lb = await json(limited);
    expect(lb.error).toBe("verify_rate_limited");
    expect(lb.retryAfterSeconds).toBeGreaterThan(0);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(resend.calls.filter((c) => c.op === "verify")).toHaveLength(1);
    // 31 s later (clock is injected, the DB timestamp came from the same clock)
    clock = new Date(clock.getTime() + 31_000);
    expect((await post(u.cookie, "/onboarding/domain/verify")).status).toBe(200);
    expect(resend.calls.filter((c) => c.op === "verify")).toHaveLength(2);
  });
  it("answers 502 when Resend fails the verify call", async () => {
    const u = await makeUser();
    await addDomain(u);
    resend.failNext("verify", new ResendDomainError(500, undefined, ""));
    expect((await post(u.cookie, "/onboarding/domain/verify")).status).toBe(502);
  });
});

describe("DELETE /onboarding/domain", () => {
  it("frees the slot while unverified and refuses once verified", async () => {
    const u = await makeUser();
    const { name } = await addDomain(u);
    expect(resend.store.size).toBe(1);
    expect((await call(u.cookie, "/onboarding/domain", { method: "DELETE" })).status).toBe(200);
    expect(resend.store.size).toBe(0);
    expect(await getUserDomain(handle.db, u.id)).toBeNull();
    // the typo can be fixed and the old name is free again
    expect((await post(u.cookie, "/onboarding/domain", { name })).status).toBe(201);
    await verifyFor(u);
    const refused = await call(u.cookie, "/onboarding/domain", { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toBe("domain_verified");
    expect(resend.store.size).toBe(1);
  });
});

// ---------------------------------------------------------------- background verifier

describe("background verifier", () => {
  const gets = () => resend.calls.filter((c) => c.op === "get").length;
  const advance = (ms: number) => void (clock = new Date(clock.getTime() + ms));

  it("follows the backoff schedule: 15 s, then 2 min, then 15 min, then stops", async () => {
    const u = await makeUser();
    await addDomain(u); // the creation check happens at `clock`
    const t0 = clock.getTime();
    const at = (ms: number) => void (clock = new Date(t0 + ms));
    const run = async (ms: number) => {
      at(ms);
      return (await svc.verifier.tick()).length;
    };
    const mine = async (ms: number) => {
      const before = gets();
      await run(ms);
      return gets() - before;
    };
    expect(await mine(14_000)).toBe(0);
    expect(await mine(15_000)).toBe(1);
    expect(await mine(20_000)).toBe(0);
    expect(await mine(30_000)).toBe(1);
    // after the first 10 minutes: every 2 minutes
    expect(await mine(11 * 60_000)).toBe(1);
    expect(await mine(12 * 60_000)).toBe(0);
    expect(await mine(13 * 60_000 + 1000)).toBe(1);
    // after 2 hours: every 15 minutes
    expect(await mine(3 * 3600_000)).toBe(1);
    expect(await mine(3 * 3600_000 + 14 * 60_000)).toBe(0);
    expect(await mine(3 * 3600_000 + 15 * 60_000)).toBe(1);
    // after 72 hours: it stops
    expect(await mine(73 * 3600_000)).toBe(0);
    expect(await mine(100 * 3600_000)).toBe(0);
    // "Check now" restarts the fast phase
    clock = new Date(t0 + 100 * 3600_000);
    expect((await post(u.cookie, "/onboarding/domain/verify")).status).toBe(200);
    advance(16_000);
    const before = gets();
    await svc.verifier.tick();
    expect(gets() - before).toBe(1);
  });

  it("verifies automatically once every record is visible in DNS, then follows Resend to verified", async () => {
    const u = await makeUser();
    const { name } = await addDomain(u);
    const row = (await getUserDomain(handle.db, u.id))!;
    // nothing in DNS yet: checks happen, no verify call
    advance(16_000);
    await svc.verifier.tick();
    expect(resend.calls.some((c) => c.op === "verify")).toBe(false);
    // all records appear
    dns.publish(name, (await resend.getDomain(row.resendDomainId)).records);
    advance(16_000);
    await svc.verifier.tick();
    expect(resend.calls.filter((c) => c.op === "verify")).toHaveLength(1);
    let v = await json(await call(u.cookie, "/onboarding/domain"));
    expect(v.status).toBe("pending");
    expect(v.records.every((r: any) => r.dnsFound === true)).toBe(true);
    // still pending: no second verify request on the next passes
    advance(16_000);
    await svc.verifier.tick();
    expect(resend.calls.filter((c) => c.op === "verify")).toHaveLength(1);
    // Resend finishes
    resend.setStatus(row.resendDomainId, "verified");
    advance(2 * 60_000);
    await svc.verifier.tick();
    v = await json(await call(u.cookie, "/onboarding/domain"));
    expect(v).toMatchObject({ status: "verified", nextCheckAt: null });
    expect(v.verifiedAt).not.toBeNull();
    // verified domains are not looked at again
    const before = resend.calls.length;
    advance(60 * 60_000);
    expect(await svc.verifier.tick()).toEqual([]);
    expect(resend.calls.length).toBe(before);
  });

  it("does not verify while only some records are in DNS", async () => {
    const u = await makeUser();
    const { name } = await addDomain(u);
    const row = (await getUserDomain(handle.db, u.id))!;
    dns.publish(name, (await resend.getDomain(row.resendDomainId)).records.slice(0, 4));
    advance(16_000);
    await svc.verifier.tick();
    expect(resend.calls.some((c) => c.op === "verify")).toBe(false);
    const v = await json(await call(u.cookie, "/onboarding/domain"));
    expect(v.records.filter((r: any) => r.dnsFound)).toHaveLength(4);
  });

  it("survives a Resend outage and keeps the last known state", async () => {
    const u = await makeUser();
    await addDomain(u);
    resend.failNext("get", new ResendDomainError(500, undefined, ""));
    advance(16_000);
    expect(await svc.verifier.tick()).toHaveLength(1);
    const v = await json(await call(u.cookie, "/onboarding/domain"));
    expect(v.records).toHaveLength(5);
    expect(v.lastCheckedAt).toBe(clock.toISOString());
  });
});

// ---------------------------------------------------------------- webhook

describe("Resend domain.* webhook events", () => {
  async function send(payload: Record<string, unknown>, signature?: string) {
    const body = JSON.stringify(payload);
    const id = `msg_${randomBytes(8).toString("hex")}`;
    const ts = String(Math.floor(Date.now() / 1000));
    return app.request("/webhooks/resend", {
      method: "POST",
      headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": signature ?? signSvix(SECRET, id, ts, body) },
      body,
    });
  }

  it("domain.updated with a full payload updates status and records", async () => {
    const u = await makeUser();
    const { name } = await addDomain(u);
    const row = (await getUserDomain(handle.db, u.id))!;
    const records = sampleRecords(name, "ap-northeast-1", "verified").map((r) => (r.type === "TXT" ? { ...r, value: `"${r.value}"` } : r));
    const before = resend.calls.length;
    const res = await send({ type: "domain.updated", created_at: new Date().toISOString(), data: { id: row.resendDomainId, name, status: "verified", region: "ap-northeast-1", records } });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: "updated" });
    expect(resend.calls.length).toBe(before); // no refetch needed
    const v = await json(await call(u.cookie, "/onboarding/domain"));
    expect(v.status).toBe("verified");
    expect(v.verifiedAt).not.toBeNull();
    expect(v.records.every((r: any) => r.resendStatus === "verified")).toBe(true);
    expect(v.records.find((r: any) => r.purpose === "SPF").value).not.toMatch(/^"/); // quotes stripped for display
  });

  it("refetches via GET /domains/{id} when the payload is partial", async () => {
    const u = await makeUser();
    await addDomain(u);
    const row = (await getUserDomain(handle.db, u.id))!;
    resend.setStatus(row.resendDomainId, "pending");
    const res = await send({ type: "domain.updated", data: { id: row.resendDomainId } });
    expect(res.status).toBe(200);
    expect(resend.calls.filter((c) => c.op === "get").length).toBe(1);
    expect((await getUserDomain(handle.db, u.id))?.status).toBe("pending");
  });

  it("ignores unknown domains, rejects bad signatures, and handles domain.deleted", async () => {
    const u = await makeUser();
    await addDomain(u);
    const row = (await getUserDomain(handle.db, u.id))!;
    expect(await json(await send({ type: "domain.updated", data: { id: "someone-elses", status: "verified" } }))).toEqual({ status: "ignored" });
    const forged = await send({ type: "domain.updated", data: { id: row.resendDomainId, status: "verified" } }, "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect(forged.status).toBe(401);
    expect((await getUserDomain(handle.db, u.id))?.status).toBe("not_started");
    expect(await json(await send({ type: "domain.deleted", data: { id: row.resendDomainId } }))).toEqual({ status: "deleted" });
    expect(await getUserDomain(handle.db, u.id)).toBeNull();
  });

  it("still ignores other event types", async () => {
    const res = await send({ type: "email.delivered", data: { email_id: "x" } });
    expect(await json(res)).toEqual({ status: "ignored" });
  });
});

// ---------------------------------------------------------------- onboarding state + agents

describe("onboarding state", () => {
  it("includes the domain in /me and /onboarding/status", async () => {
    const u = await makeUser();
    expect((await json(await call(u.cookie, "/me"))).domain).toBeNull();
    const { name } = await addDomain(u);
    expect((await json(await call(u.cookie, "/me"))).domain).toEqual({ name, status: "not_started" });
    expect((await json(await call(u.cookie, "/onboarding/status"))).domain).toEqual({ name, status: "not_started" });
  });
  it("exposes the shared mail domain for the zero-setup option", async () => {
    const u = await makeUser();
    expect((await json(await call(u.cookie, "/onboarding/status"))).sharedMailDomain).toBe(SHARED);
  });
  it("complete never needs a verified domain (optional): no domain, a pending one, or a verified one", async () => {
    const none = await makeUser();
    expect(await json(await post(none.cookie, "/onboarding/complete"))).toEqual({ onboardingState: "done" });
    const pending = await makeUser();
    await addDomain(pending);
    expect((await post(pending.cookie, "/onboarding/complete")).status).toBe(200);
    expect((await json(await call(pending.cookie, "/me"))).onboardingState).toBe("done");
    // verification keeps running in the background after the user finished
    expect((await json(await call(pending.cookie, "/me"))).domain.status).toBe("not_started");
    await verifyFor(pending);
    expect((await json(await call(pending.cookie, "/me"))).domain.status).toBe("verified");
    const verified = await makeUser();
    await addDomain(verified);
    await verifyFor(verified);
    expect((await post(verified.cookie, "/onboarding/complete")).status).toBe(200);
    const legacy = await makeUser("done");
    expect(await json(await post(legacy.cookie, "/onboarding/complete"))).toEqual({ onboardingState: "done" });
    expect((await json(await call(legacy.cookie, "/me"))).domain).toBeNull();
  });
});

describe("agents on the user's domain", () => {
  const addAgent = (cookie: string, name: string) =>
    post(cookie, "/agents", { name, index: 0, walletAddress: privateKeyToAccount(generatePrivateKey()).address });

  it("creates <agent>@<user domain>, writes it to the ENS email record, and routes its mail", async () => {
    const u = await makeUser();
    const { name } = await addDomain(u);
    await verifyFor(u);
    const res = await addAgent(u.cookie, "Alex");
    expect(res.status).toBe(202);
    const b = await json(res);
    expect(b.agent.email).toBe(`alex@${name}`);
    for (let i = 0; i < 100 && creates.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(creates[0]).toMatchObject({ agentLabel: "alex", email: `alex@${name}` });
    const route = await findMailboxByAddress(handle.db, `ALEX@${name.toUpperCase()}`);
    expect(route?.agentId).toBe(b.agent.id);
    expect(route?.mailboxStatus).toBe("active");
    // mail to an address nobody owns on a verified user domain is dropped
    expect(await findMailboxByAddress(handle.db, `nobody@${name}`)).toBeNull();
    const body = JSON.stringify({ type: "email.received", data: { email_id: "fake-conv-0001", from: "S <s@example.org>", to: [`nobody@${name}`], received_for: [`nobody@${name}`], subject: "x", attachments: [] } });
    const id = `msg_${randomBytes(8).toString("hex")}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const dropped = await app.request("/webhooks/resend", { method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": signSvix(SECRET, id, ts, body) }, body });
    expect(await json(dropped)).toEqual({ status: "dropped" });
  });

  it("uses the shared <agent>.<user>@SHARED_MAIL_DOMAIN address without a domain, never a 409", async () => {
    for (const state of ["name_claimed", "done"] as const) {
      const u = await makeUser(state);
      const res = await addAgent(u.cookie, "scout");
      expect(res.status).toBe(202);
      expect((await json(res)).agent.email).toBe(`scout.${u.username}@${SHARED}`);
    }
  });

  it("uses the shared address while the user's domain is still pending", async () => {
    const u = await makeUser();
    await addDomain(u);
    const res = await addAgent(u.cookie, "alex");
    expect(res.status).toBe(202);
    expect((await json(res)).agent.email).toBe(`alex.${u.username}@${SHARED}`);
  });

  it("existing agents keep their address when the domain verifies later; new ones use the domain", async () => {
    const u = await makeUser();
    const { name } = await addDomain(u);
    const first = await json(await addAgent(u.cookie, "alex"));
    expect(first.agent.email).toBe(`alex.${u.username}@${SHARED}`);
    await verifyFor(u);
    const second = await json(await post(u.cookie, "/agents", { name: "scout", index: 1, walletAddress: privateKeyToAccount(generatePrivateKey()).address }));
    expect(second.agent.email).toBe(`scout@${name}`);
    const list = (await json(await call(u.cookie, "/agents"))).agents as Array<{ name: string; email: string }>;
    expect(list.find((a) => a.name === "alex")?.email).toBe(`alex.${u.username}@${SHARED}`);
    expect(list.find((a) => a.name === "scout")?.email).toBe(`scout@${name}`);
    // the old address still routes
    expect((await findMailboxByAddress(handle.db, `alex.${u.username}@${SHARED}`))?.agentId).toBe(first.agent.id);
  });
});

// ---------------------------------------------------------------- secrets

describe("secrets", () => {
  it("never logs the Resend key, record values or request bodies", async () => {
    const KEY = "re_SUPER_SECRET_KEY_0123456789";
    const seen: string[] = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      seen.push(String(new Headers(init.headers).get("authorization")));
      if (init.method === "POST" && String(url).endsWith("/domains")) {
        return new Response(JSON.stringify({ statusCode: 403, name: "validation_error", message: "You have reached the limit of domains" }), { status: 403 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const service = createDomainService({ db: handle.db, resend: createResendDomains({ apiKey: KEY, fetch: f }), dns, defaultRegion: "ap-northeast-1", reservedDomains: [], log: (l) => logs.push(l), now: () => clock });
    const u = await makeUser();
    const appKey = createApp({ db: { ping: async () => undefined }, webOrigin: ORIGIN, version: "t", log: (l) => logs.push(l), auth: { db: handle.db, chainIds: [11155111], secureCookie: false }, domains: service });
    const res = await appKey.request("/onboarding/domain", { method: "POST", headers: { cookie: u.cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ name: domainName() }) });
    expect(res.status).toBe(409);
    expect(seen.every((h) => h === `Bearer ${KEY}`)).toBe(true);
    const text = (await res.text()) + logs.join("\n");
    expect(text).not.toContain(KEY);
    // a normal flow logs ids and statuses only
    logs = [];
    await addDomain(u);
    await post(u.cookie, "/onboarding/domain/verify");
    const joined = logs.join("\n");
    expect(joined).not.toContain("p=MIGf");
    expect(joined).not.toContain("forge.rmta.net");
  });
  it("keeps the table free of anything but public DNS data", async () => {
    const u = await makeUser();
    await addDomain(u);
    const [row] = await handle.db.select().from(userDomains).where(eq(userDomains.userId, u.id));
    expect(Object.keys(row!).sort()).toEqual(
      ["createdAt", "dnsCheck", "id", "lastVerifyRequestedAt", "name", "records", "region", "resendDomainId", "status", "updatedAt", "userId", "verifiedAt"],
    );
  });
});
