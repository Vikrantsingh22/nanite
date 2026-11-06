import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmailRecord } from "@nanite/arkiv";
import { encryptEmail, generateUserKeypair, keyId, ready } from "@nanite/crypto";
import { agents, apiTokens, auditLog, createDb, users } from "@nanite/db";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { parseMasterKey, sealAgentPrivateKey } from "../src/agent-api/keys.js";
import { createRateLimiter } from "../src/agent-api/rate-limit.js";
import { hashToken, issueAgentToken } from "../src/agent-api/tokens.js";
import type { AgentReader } from "../src/routes/v1.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
const SUBJECT = "SUBJECTMARKER-t34 secret subject";
const BODY = "BODYMARKER-t34 secret body";
const OTP = "907413";
const LINK = "https://example.com/LINKMARKER-t34";
const MASTER = parseMasterKey(randomBytes(32).toString("hex"));

const handle = createDb(DATABASE_URL, { max: 3 });
const tag = randomBytes(4).toString("hex");
const logs: string[] = [];
const consoleSpies: string[] = [];

interface TestAgent {
  id: string;
  ens: string;
  keyId: string;
  publicKey: Uint8Array;
  token: string;
  tokenId: string;
}

class FakeReader implements AgentReader {
  records: EmailRecord[] = [];
  async listInbox(o: Parameters<AgentReader["listInbox"]>[0]) {
    let items = this.records.filter((r) => r.agentId === o.agentId);
    if (o.types?.length) items = items.filter((r) => o.types!.includes(r.type));
    if (o.before !== undefined) items = items.filter((r) => r.receivedAt < o.before!);
    if (o.after !== undefined) items = items.filter((r) => r.receivedAt > o.after!);
    items = items.sort((a, b) => b.receivedAt - a.receivedAt).slice(0, o.limit ?? 25);
    return { items, skipped: 0 };
  }
  async latestOtp(agentId: string) {
    return (await this.listInbox({ agentId, types: ["otp"], limit: 1 })).items[0] ?? null;
  }
  async getEmail(k: `0x${string}`) {
    return this.records.find((r) => r.$key === k) ?? null;
  }
}

const reader = new FakeReader();
let A: TestAgent;
let B: TestAgent;
let SELF: TestAgent;
const userIds: string[] = [];
let n = 0;

async function makeAgent(userId: string, custody: "nanite" | "self", label: string): Promise<TestAgent> {
  const kp = await generateUserKeypair();
  const id = crypto.randomUUID();
  const ens = `${label}-${tag}.t34.nanitecom.eth`;
  const wallet = "0x" + randomBytes(20).toString("hex");
  await handle.db.insert(agents).values({
    id,
    userId,
    name: `${label}${tag}`,
    derivationIndex: n++,
    walletAddress: wallet,
    ensName: ens,
    publicKey: Buffer.from(kp.publicKey),
    keyId: keyId(kp.publicKey),
    custody,
    encryptedPrivateKey: custody === "nanite" ? Buffer.from(await sealAgentPrivateKey(MASTER, id, kp.privateKey)) : null,
  });
  const { token, tokenId } = await issueAgentToken(handle.db, id);
  return { id, ens, keyId: keyId(kp.publicKey), publicKey: kp.publicKey, token, tokenId };
}

async function addEmail(agent: TestAgent, type: "otp" | "conversation", receivedAt: number, withContent = true) {
  const enc = await encryptEmail(
    { subject: SUBJECT, body: BODY, meta: { ...(type === "otp" ? { otp: OTP } : {}), links: [LINK] } },
    [{ keyId: agent.keyId, publicKey: agent.publicKey }],
  );
  const key = ("0x" + randomBytes(32).toString("hex")) as `0x${string}`;
  const rec: EmailRecord = {
    $key: key,
    $owner: "0x0000000000000000000000000000000000000001",
    $creator: "0x0000000000000000000000000000000000000002",
    $expiresAt: 123456n,
    agentId: agent.ens,
    ownerId: "0x0000000000000000000000000000000000000001",
    type,
    receivedAt,
    threadId: "t".repeat(32),
    senderHash: "a".repeat(64),
    keyIds: enc.keyIds,
    ciphertext: enc.ciphertext,
    wrappedKeys: enc.wrappedKeys,
    nonce: enc.nonce,
  };
  if (withContent) reader.records.push(rec);
  return rec;
}

function makeApp(opts: Partial<NonNullable<Parameters<typeof createApp>[0]["v1"]>> = {}) {
  return createApp({
    db: { ping: async () => void (await handle.client`select 1`) },
    webOrigin: "http://localhost:3000",
    version: "t",
    log: (l) => logs.push(l),
    v1: { db: handle.db, reader, masterKey: MASTER, waitPollMs: 20, ...opts },
  });
}
const get = (app: ReturnType<typeof makeApp>, path: string, token?: string) =>
  app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeAll(async () => {
  await ready();
  for (const m of ["log", "error", "warn", "info", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleSpies.push(a.map(String).join(" ")));
  }
  for (const u of ["a", "b"]) {
    const [row] = await handle.db
      .insert(users)
      .values({ walletAddress: "0x" + randomBytes(20).toString("hex"), username: `t34${u}${tag}` })
      .returning({ id: users.id });
    userIds.push(row!.id);
  }
  A = await makeAgent(userIds[0]!, "nanite", "a");
  B = await makeAgent(userIds[1]!, "nanite", "b");
  SELF = await makeAgent(userIds[0]!, "self", "s");
});

afterAll(async () => {
  vi.restoreAllMocks();
  await handle.db.delete(users).where(inArray(users.id, userIds));
  await handle.close();
});

describe("tokens", () => {
  it("returns a nan_ token once and stores only its SHA-256", async () => {
    expect(A.token).toMatch(/^nan_[A-Za-z0-9_-]{43}$/);
    const rows = await handle.db.select().from(apiTokens).where(eq(apiTokens.agentId, A.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashToken(A.token));
    expect(JSON.stringify(rows)).not.toContain(A.token);
  });

  it("rejects missing, malformed and unknown tokens with 401", async () => {
    const app = makeApp();
    expect((await get(app, "/v1/inbox")).status).toBe(401);
    expect((await get(app, "/v1/inbox", "garbage")).status).toBe(401);
    expect((await get(app, "/v1/inbox", "nan_" + "x".repeat(43))).status).toBe(401);
  });

  it("rejects revoked token, expired token and revoked agent with 401", async () => {
    const app = makeApp();
    const t1 = await issueAgentToken(handle.db, A.id);
    await handle.db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, t1.tokenId));
    expect((await get(app, "/v1/inbox", t1.token)).status).toBe(401);

    const t2 = await issueAgentToken(handle.db, A.id, { expiresAt: new Date(Date.now() - 1000) });
    expect((await get(app, "/v1/inbox", t2.token)).status).toBe(401);

    const c = await makeAgent(userIds[1]!, "nanite", "c");
    expect((await get(app, "/v1/inbox", c.token)).status).toBe(200);
    await handle.db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, c.id));
    expect((await get(app, "/v1/inbox", c.token)).status).toBe(401);
  });
});

describe("agent API", () => {
  it("lists only the token agent's inbox (metadata, no content)", async () => {
    const ra = await addEmail(A, "conversation", 1000);
    await addEmail(B, "conversation", 1001);
    const res = await get(makeApp(), "/v1/inbox?type=conversation&limit=10", A.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { entityKey: string }[] };
    expect(body.items.map((i) => i.entityKey)).toEqual([ra.$key]);
    expect(JSON.stringify(body)).not.toContain("MARKER");
    expect((await get(makeApp(), "/v1/inbox?type=bogus", A.token)).status).toBe(400);
    expect((await get(makeApp(), "/v1/inbox?limit=0", A.token)).status).toBe(400);
  });

  it("decrypts its own email with the untrusted wrapper, otp and links", async () => {
    const rec = await addEmail(A, "otp", 2000);
    const res = await get(makeApp(), `/v1/emails/${rec.$key}`, A.token);
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, any>;
    expect(b.content_trust).toBe("untrusted");
    expect(b.untrusted).toEqual({ subject: SUBJECT, body: BODY });
    expect(b.otp).toBe(OTP);
    expect(b.links).toEqual([LINK]);
    expect(b.type).toBe("otp");
    expect(b).not.toHaveProperty("from");
  });

  it("returns 404 for another agent's email and for unknown keys", async () => {
    const other = await addEmail(B, "conversation", 3000);
    const app = makeApp();
    expect((await get(app, `/v1/emails/${other.$key}`, A.token)).status).toBe(404);
    expect((await get(app, `/v1/emails/0x${"0".repeat(64)}`, A.token)).status).toBe(404);
    expect((await get(app, "/v1/emails/nothex", A.token)).status).toBe(400);
  });

  it("/otp/latest returns the decrypted code from meta, 404 when none", async () => {
    const app = makeApp();
    const fresh = await makeAgent(userIds[1]!, "nanite", "d");
    expect((await get(app, "/v1/otp/latest", fresh.token)).status).toBe(404);
    const rec = await addEmail(fresh, "otp", 5000);
    const res = await get(app, "/v1/otp/latest", fresh.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      otp: OTP,
      receivedAt: 5000,
      expiresAtBlock: "123456",
      entityKey: rec.$key,
    });
  });

  it("wait returns when a new matching item appears, 204 on timeout", async () => {
    const app = makeApp();
    const w = await makeAgent(userIds[1]!, "nanite", "w");
    const since = 10_000;
    await addEmail(w, "otp", since - 5); // older than since: must not match
    setTimeout(() => void addEmail(w, "otp", since + 1), 120);
    const res = await get(app, `/v1/emails/wait?type=otp&since=${since}&timeout=5`, w.token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { otp: string }).otp).toBe(OTP);

    const none = await get(app, `/v1/emails/wait?type=conversation&since=${since}&timeout=1`, w.token);
    expect(none.status).toBe(204);
    expect((await get(app, "/v1/emails/wait?timeout=31", w.token)).status).toBe(400);
  });

  it("self custody: 409 on decrypt, raw ciphertext and wrapped keys with ?raw=1", async () => {
    const rec = await addEmail(SELF, "conversation", 4000);
    const app = makeApp();
    const res = await get(app, `/v1/emails/${rec.$key}`, SELF.token);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("self_custody");
    expect((await get(app, "/v1/otp/latest", SELF.token)).status).toBe(409);
    const raw = await get(app, `/v1/emails/${rec.$key}?raw=1`, SELF.token);
    expect(raw.status).toBe(200);
    const b = (await raw.json()) as Record<string, string>;
    expect(Buffer.from(b.ciphertext!, "base64").equals(Buffer.from(rec.ciphertext))).toBe(true);
    expect(Buffer.from(b.wrappedKeys!, "base64").equals(Buffer.from(rec.wrappedKeys))).toBe(true);
    expect(b.agentKeyId).toBe(SELF.keyId);
    expect(JSON.stringify(b)).not.toContain(SUBJECT);
  });

  it("rate limits per token with 429", async () => {
    const app = makeApp({ rateLimiter: createRateLimiter({ limit: 3 }) });
    const r = await makeAgent(userIds[1]!, "nanite", "r");
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await get(app, "/v1/inbox", r.token)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const limited = await get(app, "/v1/inbox", r.token);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    // another token is unaffected
    expect((await get(app, "/v1/inbox", A.token)).status).toBe(200);
  });

  it("503 custody_unavailable without a master key, 422 with the wrong one", async () => {
    const rec = await addEmail(A, "conversation", 6000);
    const noKey = await get(makeApp({ masterKey: undefined }), `/v1/emails/${rec.$key}`, A.token);
    expect(noKey.status).toBe(503);
    const wrong = parseMasterKey(randomBytes(32).toString("hex"));
    expect((await get(makeApp({ masterKey: wrong }), `/v1/emails/${rec.$key}`, A.token)).status).toBe(503);
  });
});

describe("privacy", () => {
  it("audit_log rows hold agent, endpoint and status only", async () => {
    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.agentId, A.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["agentId", "createdAt", "endpoint", "id", "statusCode"]);
      expect(r.endpoint).toMatch(/^GET \/v1\//);
      expect(r.endpoint).not.toMatch(/0x[0-9a-f]{64}/);
    }
    const all = JSON.stringify(rows);
    for (const m of ["MARKER", OTP, A.token]) expect(all).not.toContain(m);
  });

  it("logs never contain subject, body, otp, link or token", () => {
    const all = [...logs, ...consoleSpies].join("\n");
    expect(logs.length).toBeGreaterThan(0);
    for (const m of ["SUBJECTMARKER", "BODYMARKER", "LINKMARKER", OTP, A.token, B.token]) {
      expect(all).not.toContain(m);
    }
  });
});
