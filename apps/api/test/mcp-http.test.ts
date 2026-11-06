/*
 * Hosted MCP endpoint (POST /mcp, Streamable HTTP, stateless JSON). Same bearer token, rate limit and audit as /v1;
 * the tools call the /v1 routes in-process. Fakes only (reader, mail provider, ENS, Arkiv writer).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { EmailRecord } from "@nanite/arkiv";
import { encryptEmail, generateUserKeypair, keyId, ready } from "@nanite/crypto";
import { agents, auditLog, createDb, userKeys, users } from "@nanite/db";
import type { SendPolicy } from "@nanite/ens";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { parseMasterKey, sealAgentPrivateKey } from "../src/agent-api/keys.js";
import { createRateLimiter } from "../src/agent-api/rate-limit.js";
import { issueAgentToken } from "../src/agent-api/tokens.js";
import { InMemoryArkivWriter } from "../src/arkiv/port.js";
import { createFakeMailProvider } from "../src/mail/fake.js";
import type { AgentReader } from "../src/routes/v1.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
const SUBJECT = "SUBJECTMARKER-t37mcp subject";
const BODY = "BODYMARKER-t37mcp body";
const MASTER = parseMasterKey(randomBytes(32).toString("hex"));
const handle = createDb(DATABASE_URL, { max: 3 });
const tag = randomBytes(4).toString("hex");

interface TestAgent { id: string; ens: string; keyId: string; publicKey: Uint8Array; token: string }
let A: TestAgent;
let SELF: TestAgent;
let userId: string;
const records: EmailRecord[] = [];
const reader: AgentReader = {
  async listInbox(o) {
    let items = records.filter((r) => r.agentId === o.agentId);
    if (o.types?.length) items = items.filter((r) => o.types!.includes(r.type));
    if (o.after !== undefined) items = items.filter((r) => r.receivedAt > o.after!);
    return { items: items.sort((a, b) => b.receivedAt - a.receivedAt).slice(0, o.limit ?? 25), skipped: 0 };
  },
  async latestOtp(agentId) {
    return (await this.listInbox({ agentId, types: ["otp"], limit: 1 })).items[0] ?? null;
  },
  async getEmail(k) {
    return records.find((r) => r.$key === k) ?? null;
  },
};
const policy: SendPolicy = { policy: "any", allow: [], limit: 50 };
const provider = createFakeMailProvider({ webhookSecret: "whsec_" + Buffer.from("x".repeat(24)).toString("base64") });
const arkiv = new InMemoryArkivWriter();
const noReader = { listInbox: async () => ({ items: [] as EmailRecord[] }), getEmail: async () => null };

function makeApp(rateLimiter?: ReturnType<typeof createRateLimiter>) {
  return createApp({
    db: { ping: async () => undefined },
    webOrigin: "http://localhost:3000",
    version: "t",
    log: () => undefined,
    v1: {
      db: handle.db,
      reader,
      masterKey: MASTER,
      waitPollMs: 20,
      ...(rateLimiter ? { rateLimiter } : {}),
      outbound: {
        provider,
        reader: noReader,
        arkiv,
        ens: { readSendPolicy: async () => ({ ...policy }), resolveEmail: async () => null },
        senderHashSecret: "test-sender-hash-secret-0123456789",
        sharedMailDomain: "mail.nanite.test",
      },
    },
  });
}
type App = ReturnType<typeof makeApp>;

async function mcpClient(app: App, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL("http://api.test/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: ((url: string | URL, init?: RequestInit) => app.fetch(new Request(url, init))) as typeof fetch,
  });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(transport);
  return client;
}
const json = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

async function makeAgent(custody: "nanite" | "self", label: string, n: number): Promise<TestAgent> {
  const kp = await generateUserKeypair();
  const id = crypto.randomUUID();
  const ens = `${label}-${tag}.t37mcp.nanitecom.eth`;
  await handle.db.insert(agents).values({
    id, userId, name: `${label}${tag}`, derivationIndex: n, walletAddress: "0x" + randomBytes(20).toString("hex"),
    ensName: ens, publicKey: Buffer.from(kp.publicKey), keyId: keyId(kp.publicKey), custody,
    encryptedPrivateKey: custody === "nanite" ? Buffer.from(await sealAgentPrivateKey(MASTER, id, kp.privateKey)) : null,
  });
  return { id, ens, keyId: keyId(kp.publicKey), publicKey: kp.publicKey, token: (await issueAgentToken(handle.db, id)).token };
}

async function addEmail(agent: TestAgent, type: "otp" | "conversation", receivedAt: number, meta: Record<string, unknown>) {
  const enc = await encryptEmail({ subject: SUBJECT, body: BODY, meta }, [{ keyId: agent.keyId, publicKey: agent.publicKey }]);
  const rec: EmailRecord = {
    $key: ("0x" + randomBytes(32).toString("hex")) as `0x${string}`,
    $owner: "0x0000000000000000000000000000000000000001",
    $creator: "0x0000000000000000000000000000000000000002",
    $expiresAt: 123456n, agentId: agent.ens, ownerId: "0x0000000000000000000000000000000000000001",
    type, receivedAt, threadId: "t".repeat(32), senderHash: "a".repeat(64),
    keyIds: enc.keyIds, ciphertext: enc.ciphertext, wrappedKeys: enc.wrappedKeys, nonce: enc.nonce,
  };
  records.push(rec);
  return rec;
}

beforeAll(async () => {
  await ready();
  const [u] = await handle.db.insert(users).values({ walletAddress: "0x" + randomBytes(20).toString("hex"), username: `t37m${tag}` }).returning({ id: users.id });
  userId = u!.id;
  const userKp = await generateUserKeypair();
  const ph = Buffer.from("x");
  await handle.db.insert(userKeys).values({
    userId, publicKey: Buffer.from(userKp.publicKey), keyId: keyId(userKp.publicKey),
    wrappedPrivateKeyWallet: ph, wrappedPrivateKeyRecovery: ph, wrappedSeedWallet: ph, wrappedSeedRecovery: ph, walletSalt: ph, recoverySalt: ph,
  });
  A = await makeAgent("nanite", "a", 0);
  SELF = await makeAgent("self", "s", 1);
});
afterAll(async () => {
  await handle.db.delete(users).where(inArray(users.id, [userId]));
  await handle.close();
});

describe("POST /mcp", () => {
  it("requires the agent bearer token (401 for none, bad, revoked)", async () => {
    const app = makeApp();
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
    const call = (auth?: string) =>
      app.request("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify(init),
      });
    expect((await call()).status).toBe(401);
    expect((await call("Bearer nan_" + "x".repeat(43))).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
    expect((await call(`Bearer ${A.token}`)).status).toBe(200);
    const t = await issueAgentToken(handle.db, A.id);
    await handle.db.execute(`update api_tokens set revoked_at = now() where id = '${t.tokenId}'` as never);
    expect((await call(`Bearer ${t.token}`)).status).toBe(401);
  });

  it("lists the seven tools", async () => {
    const c = await mcpClient(makeApp(), A.token);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["extend_email", "get_email", "get_latest_otp", "list_inbox", "send_email", "wait_for_email", "whoami"]);
    await c.close();
  });

  it("whoami returns the agent's own ensName, custody and email", async () => {
    const c = await mcpClient(makeApp(), A.token);
    const me = json(await c.callTool({ name: "whoami", arguments: {} }));
    expect(me).toMatchObject({ ensName: A.ens, custody: "nanite" });
    expect(Object.keys(me).sort()).toEqual(["custody", "email", "ensName"]);
    expect(me.email === null || /@mail\.nanite\.test$/.test(me.email)).toBe(true);
    await c.close();
  });

  it("list_inbox, get_email, get_latest_otp work through the hosted endpoint; content is untrusted and decrypted server-side", async () => {
    const o = await addEmail(A, "otp", 100, { otp: "731942", links: ["https://x.example/l"] });
    await addEmail(A, "conversation", 50, {});
    const c = await mcpClient(makeApp(), A.token);

    const list = json(await c.callTool({ name: "list_inbox", arguments: { limit: 10 } }));
    expect(list.items.map((i: { entityKey: string }) => i.entityKey)).toContain(o.$key);
    expect(JSON.stringify(list)).not.toMatch(/MARKER/); // metadata only

    const email = json(await c.callTool({ name: "get_email", arguments: { entityKey: o.$key } }));
    expect(email).toMatchObject({ content_trust: "untrusted", otp: "731942", links: ["https://x.example/l"], untrusted: { subject: SUBJECT, body: BODY } });

    const otp = json(await c.callTool({ name: "get_latest_otp", arguments: {} }));
    expect(otp).toMatchObject({ otp: "731942", entityKey: o.$key, content_trust: "untrusted" });

    const w = json(await c.callTool({ name: "wait_for_email", arguments: { since: 0, timeout: 1 } }));
    expect(w.untrusted.body).toBe(BODY);
    const none = json(await c.callTool({ name: "wait_for_email", arguments: { since: 9_999_999_999, timeout: 0 } }));
    expect(none.status).toBe("timeout");
    await c.close();
  });

  it("send_email applies the send policy and sends through the same path as /v1/emails/send", async () => {
    const c = await mcpClient(makeApp(), A.token);
    const sent = provider.sent.length;
    const ok = json(await c.callTool({ name: "send_email", arguments: { to: "Someone@Example.com", subject: "Hello", body: "From MCP" } }));
    expect(ok).toMatchObject({ status: "sent", signature: "unavailable" }); // nanite custody, but this test agent has no signer key
    expect(provider.sent.length).toBe(sent + 1);
    expect(provider.sent.at(-1)).toMatchObject({ to: ["someone@example.com"], subject: "Hello", text: "From MCP" });

    policy.policy = "off";
    const denied = await c.callTool({ name: "send_email", arguments: { to: "a@example.com", subject: "x", body: "y" } });
    policy.policy = "any";
    expect(denied.isError).toBe(true);
    expect(json(denied)).toEqual({ error: "policy_off", status: 403 });
    expect(provider.sent.length).toBe(sent + 1);
    await c.close();
  });

  it("a self-hosted agent is refused with a clear pointer to local mode", async () => {
    const app = makeApp();
    const r = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${SELF.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(403);
    const b = (await r.json()) as { error: string; message: string };
    expect(b.error).toBe("self_custody");
    expect(b.message).toMatch(/NANITE_AGENT_KEY_FILE/);
  });

  it("only POST is served (405), and the body is size-limited", async () => {
    const app = makeApp();
    const get = await app.request("/mcp", { headers: { authorization: `Bearer ${A.token}` } });
    expect(get.status).toBe(405);
    const big = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${A.token}`, "content-type": "application/json" },
      body: "x".repeat(200_000),
    });
    expect(big.status).toBe(413);
  });

  it("is rate limited like /v1 (one hit per /mcp request, tool calls are not counted twice) and audited", async () => {
    let hits = 0;
    const limiter = { hit: () => ((hits += 1), { allowed: true, retryAfterSec: 1 }) } as ReturnType<typeof createRateLimiter>;
    const app = makeApp(limiter);
    let requests = 0;
    const counting = {
      ...app,
      fetch: (r: Request) => ((requests += 1), app.fetch(r)),
    } as unknown as App;
    const before = (await handle.db.select().from(auditLog).where(eq(auditLog.agentId, A.id))).length;
    const c = await mcpClient(counting, A.token);
    await c.callTool({ name: "list_inbox", arguments: {} });
    await c.callTool({ name: "get_latest_otp", arguments: {} });
    await c.close();
    expect(requests).toBeGreaterThanOrEqual(3);
    expect(hits).toBe(requests); // every /mcp request hit the limiter exactly once; the in-process /v1 calls added none
    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.agentId, A.id));
    expect(rows.length).toBeGreaterThan(before);
    expect(rows.some((r) => r.endpoint === "POST /mcp" && r.statusCode === 200)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/MARKER|Hello/);

    const strict = makeApp(createRateLimiter({ limit: 2 }));
    const hit = () =>
      strict.request("/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${A.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    const codes = [(await hit()).status, (await hit()).status, (await hit()).status];
    expect(codes).toEqual([200, 200, 429]);
  });

  it("the in-process shortcut cannot be used from outside: a guessed x-nanite-internal header is still rate limited", async () => {
    const app = makeApp(createRateLimiter({ limit: 1 }));
    const call = () => app.request("/v1/inbox", { headers: { authorization: `Bearer ${A.token}`, "x-nanite-internal": "guess" } });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });
});
