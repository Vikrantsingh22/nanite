/*
 * T3.8 email expiry control: extend routes (agent token + user session), the daily limit, expiry fields on reads and
 * the hosted MCP tool. Fakes only: no Arkiv or ENS writes.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { EmailRecord } from "@nanite/arkiv";
import { generateUserKeypair, keyId, ready } from "@nanite/crypto";
import { agents, auditLog, countExtendsSince, createDb, createSession, users, utcDayStart } from "@nanite/db";
import { DEFAULT_RETENTION, type RetentionPolicy } from "@nanite/ens";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createRateLimiter } from "../src/agent-api/rate-limit.js";
import { issueAgentToken } from "../src/agent-api/tokens.js";
import { InMemoryArkivWriter } from "../src/arkiv/port.js";
import { createRetentionSource } from "../src/retention.js";
import type { AgentReader } from "../src/routes/v1.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
const handle = createDb(DATABASE_URL, { max: 8 });
const tag = randomBytes(4).toString("hex");
const hex = (n: number) => randomBytes(n).toString("hex");
const ORIGIN = "http://localhost:3000";
const BLOCK = 1_000_000n;
const DAY = 43_200n; // blocks per day

interface U { id: string; wallet: string; cookie: string; agentId: string; ens: string; token: string }
let A: U; // user A, hosted agent
let A2: U; // user A, self-hosted agent (same wallet)
let A3: U; // user A, third agent (fresh daily allowance for the race test)
let B: U; // another user
const userIds: string[] = [];
const records: EmailRecord[] = [];
let retention: RetentionPolicy = { ...DEFAULT_RETENTION };
let retentionFails = false;

class TestArkiv extends InMemoryArkivWriter {
  failNext = false;
  override async extendEmail(entityKey: string, seconds: number) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("ArkivWriteError: extend failed: boom");
    }
    await new Promise((r) => setTimeout(r, 5)); // widen the race window
    return super.extendEmail(entityKey, seconds);
  }
}
const arkiv = new TestArkiv();

const reader: AgentReader = {
  async listInbox(o) {
    let items = records.filter((r) => r.agentId === o.agentId);
    if (o.owner) items = items.filter((r) => r.$owner.toLowerCase() === o.owner!.toLowerCase());
    if (o.ownerId) items = items.filter((r) => r.ownerId.toLowerCase() === o.ownerId!.toLowerCase());
    if (o.types?.length) items = items.filter((r) => o.types!.includes(r.type));
    return { items: items.sort((a, b) => b.receivedAt - a.receivedAt).slice(0, o.limit ?? 25), skipped: 0 };
  },
  async latestOtp(agentId) {
    return (await this.listInbox({ agentId, types: ["otp"], limit: 1 })).items[0] ?? null;
  },
  async getEmail(k) {
    return records.find((r) => r.$key === k) ?? null;
  },
};

const retentionSource = createRetentionSource({
  read: async () => {
    if (retentionFails) throw new Error("rpc down");
    return { ...retention };
  },
});

function makeApp(keepLimiter = createRateLimiter({ limit: 1000 })) {
  return createApp({
    db: { ping: async () => undefined },
    webOrigin: ORIGIN,
    version: "t",
    log: () => undefined,
    auth: { db: handle.db, chainIds: [11155111], secureCookie: false },
    mail: { reader, blockNumber: async () => BLOCK, arkiv, keepLimiter },
    v1: { db: handle.db, reader, waitPollMs: 20, blockNumber: async () => BLOCK, arkiv, retention: retentionSource, rateLimiter: createRateLimiter({ limit: 100_000 }) },
  });
}
type App = ReturnType<typeof makeApp>;

async function makeUser(label: string, custody: "nanite" | "self" = "nanite"): Promise<U> {
  const wallet = "0x" + hex(20);
  const [row] = await handle.db.insert(users).values({ walletAddress: wallet, username: `t38${label}${tag}` }).returning({ id: users.id });
  userIds.push(row!.id);
  const u = await addAgent(row!.id, wallet, label, custody);
  return u;
}
let agentCounter = 0;
async function addAgent(userId: string, wallet: string, label: string, custody: "nanite" | "self"): Promise<U> {
  const kp = await generateUserKeypair();
  const agentId = crypto.randomUUID();
  const ens = `${label}${tag}.t38.nanitecom.eth`;
  await handle.db.insert(agents).values({
    id: agentId, userId, name: `${label}${tag}`, derivationIndex: agentCounter++, walletAddress: "0x" + hex(20), ensName: ens,
    publicKey: Buffer.from(kp.publicKey), keyId: keyId(kp.publicKey), custody,
  });
  const session = await createSession(handle.db, userId, new Date(Date.now() + 3600_000));
  const { token } = await issueAgentToken(handle.db, agentId);
  return { id: userId, wallet, cookie: `nanite_session=${session.id}`, agentId, ens, token };
}

function rec(owner: U, over: Partial<EmailRecord> = {}): EmailRecord {
  const r: EmailRecord = {
    $key: `0x${hex(32)}`,
    $owner: owner.wallet as `0x${string}`,
    $creator: "0x0000000000000000000000000000000000000002",
    $expiresAt: BLOCK + 100n,
    agentId: owner.ens,
    ownerId: owner.wallet as `0x${string}`,
    type: "conversation",
    receivedAt: 1000,
    threadId: "t".repeat(32),
    senderHash: "a".repeat(64),
    keyIds: ["0".repeat(16)],
    ciphertext: new Uint8Array([1, 2, 3]),
    wrappedKeys: new Uint8Array([4]),
    nonce: new Uint8Array(24),
    ...over,
  };
  records.push(r);
  return r;
}

const agentPost = (app: App, token: string | undefined, key: string, body: unknown) =>
  app.request(`/v1/emails/${key}/extend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const userPost = (app: App, u: U, agentId: string, key: string, body: unknown, origin = ORIGIN) =>
  app.request(`/mail/${agentId}/emails/${key}/extend`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: u.cookie, origin },
    body: JSON.stringify(body),
  });
const dayStart = () => utcDayStart(new Date());

beforeAll(async () => {
  await ready();
  A = await makeUser("a");
  const wallet = A.wallet;
  A2 = await addAgent(A.id, wallet, "s", "self");
  A3 = await addAgent(A.id, wallet, "c", "nanite");
  B = await makeUser("b");
});
afterAll(async () => {
  await handle.db.delete(auditLog).where(inArray(auditLog.agentId, [A.agentId, A2.agentId, A3.agentId, B.agentId]));
  await handle.db.delete(users).where(inArray(users.id, userIds));
  await handle.close();
});

describe("POST /v1/emails/:key/extend (agent token)", () => {
  it("extends a conversation to now + days, paid by the operator through the writer; responds with block and ISO time", async () => {
    retention = { ...DEFAULT_RETENTION };
    const r = rec(A);
    const before = arkiv.extensions.length;
    const res = await agentPost(makeApp(), A.token, r.$key, { days: 7 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; expiresAtBlock: string; expiresAt: string };
    expect(body.status).toBe("extended");
    expect(BigInt(body.expiresAtBlock)).toBe(BLOCK + 7n * DAY);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(arkiv.extensions.slice(before)).toEqual([{ entityKey: r.$key, seconds: 7 * 86_400 }]);
  });

  it("extends sent mail too, for a self-hosted agent (no decryption needed)", async () => {
    const r = rec(A2, { type: "sent" });
    const res = await agentPost(makeApp(), A2.token, r.$key, { days: 182 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("extended");
    expect(arkiv.extensions.at(-1)).toEqual({ entityKey: r.$key, seconds: 182 * 86_400 });
  });

  it("refuses OTPs with 409 otp_not_extendable and never writes", async () => {
    const r = rec(A, { type: "otp" });
    const before = arkiv.extensions.length;
    const res = await agentPost(makeApp(), A.token, r.$key, { days: 7 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "otp_not_extendable" });
    expect(arkiv.extensions.length).toBe(before);
  });

  it("never shortens: an expiry already later answers 200 unchanged, with no write and no daily count", async () => {
    const r = rec(A, { $expiresAt: BLOCK + 30n * DAY });
    const used = await countExtendsSince(handle.db, A.agentId, dayStart());
    const before = arkiv.extensions.length;
    const res = await agentPost(makeApp(), A.token, r.$key, { days: 7 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "unchanged", expiresAtBlock: String(BLOCK + 30n * DAY) });
    expect(arkiv.extensions.length).toBe(before);
    expect(await countExtendsSince(handle.db, A.agentId, dayStart())).toBe(used);
  });

  it("validates days: integer 1..182", async () => {
    const r = rec(A);
    const app = makeApp();
    for (const days of [0, -1, 183, 1.5, "7", null, undefined]) {
      const res = await agentPost(app, A.token, r.$key, { days });
      expect(res.status, String(days)).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_days" });
    }
    expect((await agentPost(app, A.token, r.$key, {})).status).toBe(400);
    expect((await agentPost(app, A.token, "0xnope", { days: 7 })).status).toBe(400);
  });

  it("only this agent's own mail: another agent's, another owner's, look-alikes and unknown keys are 404; no token is 401", async () => {
    const app = makeApp();
    const others = [
      rec(B), // another user's agent
      rec(A2), // same user, other agent
      rec(A, { $owner: ("0x" + hex(20)) as `0x${string}` }), // transferred away
      rec(A, { ownerId: ("0x" + hex(20)) as `0x${string}` }), // owner attribute differs
    ];
    const before = arkiv.extensions.length;
    for (const o of others) expect((await agentPost(app, A.token, o.$key, { days: 7 })).status).toBe(404);
    expect((await agentPost(app, A.token, `0x${hex(32)}`, { days: 7 })).status).toBe(404);
    expect((await agentPost(app, undefined, others[0]!.$key, { days: 7 })).status).toBe(401);
    expect(arkiv.extensions.length).toBe(before);
  });

  it("403 extend_disabled when ENS nanite.extend is off; 502 policy_unavailable (fail closed) when ENS cannot be read", async () => {
    const r = rec(A);
    const before = arkiv.extensions.length;
    retention = { ...DEFAULT_RETENTION, extend: "off" };
    let res = await agentPost(makeApp(), A.token, r.$key, { days: 7 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "extend_disabled" });
    retention = { ...DEFAULT_RETENTION };
    retentionFails = true;
    res = await agentPost(makeApp(), A.token, r.$key, { days: 7 });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "policy_unavailable" });
    retentionFails = false;
    expect(arkiv.extensions.length).toBe(before);
  });

  it("the daily limit is atomic: 10 parallel calls with limit 3 extend exactly 3 and refuse 7 with 429 extend_limit", async () => {
    retention = { ...DEFAULT_RETENTION, extendLimit: 3 };
    const app = makeApp();
    const mine = Array.from({ length: 10 }, () => rec(A3));
    expect(await countExtendsSince(handle.db, A3.agentId, dayStart())).toBe(0);
    const before = arkiv.extensions.length;
    const results = await Promise.all(mine.map((r) => agentPost(app, A3.token, r.$key, { days: 30 })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    for (const r of results.filter((x) => x.status === 429)) expect(await r.json()).toEqual({ error: "extend_limit" });
    expect(arkiv.extensions.length - before).toBe(3);
    expect(await countExtendsSince(handle.db, A3.agentId, dayStart())).toBe(3);
    // and the next call is refused too
    expect((await agentPost(app, A3.token, rec(A3).$key, { days: 30 })).status).toBe(429);
    retention = { ...DEFAULT_RETENTION };
  });

  it("counts per agent and per UTC day: another agent of the same user has its own allowance; limit 0 refuses everything", async () => {
    retention = { ...DEFAULT_RETENTION, extendLimit: 0 };
    const r = rec(A2);
    const res = await agentPost(makeApp(), A2.token, r.$key, { days: 7 });
    expect(res.status).toBe(429);
    retention = { ...DEFAULT_RETENTION, extendLimit: 1 };
    const used = await countExtendsSince(handle.db, A2.agentId, dayStart());
    const res2 = await agentPost(makeApp(), A2.token, rec(A2).$key, { days: 7 });
    expect(res2.status).toBe(used >= 1 ? 429 : 200);
    // yesterday's rows never count
    await handle.db.insert(auditLog).values({ agentId: B.agentId, endpoint: "extend", statusCode: 200, createdAt: new Date(dayStart().getTime() - 3600_000) });
    expect(await countExtendsSince(handle.db, B.agentId, dayStart())).toBe(0);
    retention = { ...DEFAULT_RETENTION };
  });

  it("a failed chain write answers 502 extend_failed and gives the reserved allowance back", async () => {
    retention = { ...DEFAULT_RETENTION, extendLimit: 1000 };
    const r = rec(A);
    const used = await countExtendsSince(handle.db, A.agentId, dayStart());
    arkiv.failNext = true;
    const res = await agentPost(makeApp(), A.token, r.$key, { days: 7 });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "extend_failed" });
    expect(await countExtendsSince(handle.db, A.agentId, dayStart())).toBe(used);
    expect((await agentPost(makeApp(), A.token, r.$key, { days: 7 })).status).toBe(200);
    retention = { ...DEFAULT_RETENTION };
  });

  it("writes an audit row without content: endpoint label and status only", async () => {
    const rows = await handle.db.select().from(auditLog).where(and(eq(auditLog.agentId, A.agentId), eq(auditLog.endpoint, "POST /v1/emails/:entityKey/extend")));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/0x[0-9a-f]{64}/i);
  });
});

describe("reads carry expiresAtBlock, expiresAt and extendable", () => {
  it("/v1/inbox and /v1/emails/:key?raw=1 (agent) and /mail inbox + get (user)", async () => {
    const conv = rec(A, { receivedAt: 5000, $expiresAt: BLOCK + 43_200n });
    const otp = rec(A, { type: "otp", receivedAt: 5001, $expiresAt: BLOCK + 150n });
    const app = makeApp();
    const inbox = (await (await app.request("/v1/inbox", { headers: { authorization: `Bearer ${A.token}` } })).json()) as { items: Array<Record<string, unknown>> };
    const c = inbox.items.find((i) => i.entityKey === conv.$key)!;
    expect(c).toMatchObject({ extendable: true, expiresAtBlock: String(BLOCK + 43_200n) });
    expect(Date.parse(c.expiresAt as string) - Date.now()).toBeGreaterThan(86_400_000 - 5_000);
    expect(Date.parse(c.expiresAt as string) - Date.now()).toBeLessThan(86_400_000 + 5_000);
    expect(inbox.items.find((i) => i.entityKey === otp.$key)).toMatchObject({ extendable: false });
    const raw = (await (await app.request(`/v1/emails/${conv.$key}?raw=1`, { headers: { authorization: `Bearer ${A.token}` } })).json()) as Record<string, unknown>;
    expect(raw).toMatchObject({ extendable: true, expiresAtBlock: String(BLOCK + 43_200n) });
    expect(typeof raw.expiresAt).toBe("string");

    const mine = (await (await app.request(`/mail/${A.agentId}/inbox`, { headers: { cookie: A.cookie } })).json()) as { items: Array<Record<string, unknown>> };
    expect(mine.items.find((i) => i.key === conv.$key)).toMatchObject({ extendable: true, expiresAtBlock: String(BLOCK + 43_200n) });
    expect(mine.items.find((i) => i.key === otp.$key)).toMatchObject({ extendable: false });
    expect(typeof mine.items.find((i) => i.key === conv.$key)!.expiresAt).toBe("string");
    const one = (await (await app.request(`/mail/${A.agentId}/emails/${conv.$key}`, { headers: { cookie: A.cookie } })).json()) as Record<string, unknown>;
    expect(one).toMatchObject({ extendable: true });
  });
});

describe("POST /mail/:agentId/emails/:key/extend (user session)", () => {
  it("extends for the owner even when the agent's ENS extend permission is off and its daily limit is 0 (not gated, not counted)", async () => {
    retention = { ...DEFAULT_RETENTION, extend: "off", extendLimit: 0 };
    const r = rec(A, { type: "sent" });
    const used = await countExtendsSince(handle.db, A.agentId, dayStart());
    const res = await userPost(makeApp(), A, A.agentId, r.$key, { days: 90 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; expiresAtBlock: string };
    expect(body.status).toBe("extended");
    expect(BigInt(body.expiresAtBlock)).toBe(BLOCK + 90n * DAY);
    expect(arkiv.extensions.at(-1)).toEqual({ entityKey: r.$key, seconds: 90 * 86_400 });
    expect(await countExtendsSince(handle.db, A.agentId, dayStart())).toBe(used);
    retention = { ...DEFAULT_RETENTION };
  });

  it("OTP 409, unchanged 200, bad days 400, other user's agent or mail 404, bad Origin 403, no session 401", async () => {
    const app = makeApp();
    const before = arkiv.extensions.length;
    expect(await (await userPost(app, A, A.agentId, rec(A, { type: "otp" }).$key, { days: 7 })).json()).toEqual({ error: "otp_not_extendable" });
    const kept = rec(A, { $expiresAt: BLOCK + 100n * DAY });
    expect(await (await userPost(app, A, A.agentId, kept.$key, { days: 30 })).json()).toMatchObject({ status: "unchanged" });
    const ok = rec(A);
    expect((await userPost(app, A, A.agentId, ok.$key, { days: 0 })).status).toBe(400);
    expect((await userPost(app, A, A.agentId, ok.$key, { days: 183 })).status).toBe(400);
    expect((await userPost(app, B, A.agentId, ok.$key, { days: 7 })).status).toBe(404); // not B's agent
    expect((await userPost(app, A, A.agentId, rec(B).$key, { days: 7 })).status).toBe(404); // B's mail
    expect((await userPost(app, A, A.agentId, rec(A2).$key, { days: 7 })).status).toBe(404); // another agent's mail
    expect((await userPost(app, A, A.agentId, ok.$key, { days: 7 }, "https://evil.example")).status).toBe(403);
    const anon = await app.request(`/mail/${A.agentId}/emails/${ok.$key}/extend`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ days: 7 }) });
    expect(anon.status).toBe(401);
    expect(arkiv.extensions.length).toBe(before);
  });

  it("is rate limited per user (429 rate_limited with Retry-After)", async () => {
    const app = makeApp(createRateLimiter({ limit: 2, windowMs: 60_000 }));
    const key = rec(A).$key;
    expect((await userPost(app, A, A.agentId, key, { days: 7 })).status).toBe(200);
    expect((await userPost(app, A, A.agentId, key, { days: 7 })).status).toBe(200);
    const res = await userPost(app, A, A.agentId, key, { days: 7 });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(res.headers.get("retry-after")).toBeTruthy();
    // another user has their own bucket
    expect((await userPost(app, B, B.agentId, rec(B).$key, { days: 7 })).status).toBe(200);
  });
});

describe("hosted MCP: extend_email", () => {
  async function mcp(app: App, token: string) {
    const transport = new StreamableHTTPClientTransport(new URL("http://api.test/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: ((url: string | URL, init?: RequestInit) => app.fetch(new Request(url, init))) as typeof fetch,
    });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(transport);
    return client;
  }
  const json = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

  it("lists the tool and calls POST /v1/emails/:key/extend in-process (same gates)", async () => {
    // The hosted /mcp endpoint serves custody = nanite agents only.
    const app = makeApp();
    const client = await mcp(app, A.token);
    const tools = (await client.listTools()).tools;
    const tool = tools.find((t) => t.name === "extend_email")!;
    expect(tool).toBeTruthy();
    expect(tool.description).toMatch(/only mail the user would want to keep/i);
    const r = rec(A);
    const ok = json(await client.callTool({ name: "extend_email", arguments: { entityKey: r.$key, days: 14 } }));
    expect(ok).toMatchObject({ status: "extended", expiresAtBlock: String(BLOCK + 14n * DAY) });
    const otp = (await client.callTool({ name: "extend_email", arguments: { entityKey: rec(A, { type: "otp" }).$key, days: 14 } })) as { isError?: boolean };
    expect(otp.isError).toBe(true);
    expect(json(otp)).toMatchObject({ error: "otp_not_extendable", status: 409 });
    retention = { ...DEFAULT_RETENTION, extend: "off" };
    const off = (await client.callTool({ name: "extend_email", arguments: { entityKey: rec(A).$key, days: 14 } })) as { isError?: boolean };
    expect(json(off)).toMatchObject({ error: "extend_disabled", status: 403 });
    retention = { ...DEFAULT_RETENTION };
    await client.close();
  });
});
