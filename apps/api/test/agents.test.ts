import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateNaniteSeed, generateSalt, generateUserKeypair, keyId, ready, wrapSecret } from "@nanite/crypto";
import { agents, apiTokens, createDb, domains, findMailboxByAddress, users } from "@nanite/db";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { unsealAgentPrivateKey, unsealAgentSignerKey } from "../src/agent-api/keys.js";
import { createSiweMessage } from "viem/siwe";
import type { AgentChain, AgentEvent } from "../src/agents/chain.js";
import { hashToken, verifyAgentToken } from "../src/agent-api/tokens.js";
import { createApp } from "../src/app.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
const ORIGIN = "http://localhost:3000";
const DOMAIN = "agents-test.nanite.test";
const handle = createDb(DATABASE_URL, { max: 2 });
const masterKey = new Uint8Array(randomBytes(32));
const SUFFIX = randomBytes(3).toString("hex");

class FakeAgentChain implements AgentChain {
  canWrite = true;
  creates: Array<{ username: string; agentLabel: string; agentWallet: string; email: string; encryptionPublicKeyHex: string }> = [];
  policyWrites: Array<{ agentLabel: string; policy: string; allow?: string[] | undefined; limit?: number | undefined }> = [];
  revokes: string[] = [];
  policies = new Map<string, { policy: "off" | "reply-only" | "allowlist" | "any"; allow: string[]; limit: number }>();
  failCreate = false;
  failPublish = false;
  /** ENS `nanite.signer` records by ENS name, plus a log of publish calls. */
  signerRecords = new Map<string, string>();
  publishes: Array<{ agentLabel: string; address: string }> = [];
  readFails = false;
  async publishSigner(a: { username: string; agentLabel: string; address: string }, on: (e: AgentEvent) => void) {
    on({ step: "publish-signer", phase: "start" });
    if (this.failPublish) throw new Error("rpc exploded");
    this.publishes.push({ agentLabel: a.agentLabel, address: a.address });
    this.signerRecords.set(`${a.agentLabel}.${a.username}.nanitecom.eth`, a.address);
    on({ step: "publish-signer", phase: "done", txHash: "0xfff" });
  }
  async readSigner(name: string) {
    if (this.readFails) throw new Error("rpc");
    return this.signerRecords.get(name) ?? null;
  }
  async createAgentName(a: FakeAgentChain["creates"][number], on: (e: AgentEvent) => void) {
    on({ step: "deploy-resolver", phase: "start" });
    if (this.failCreate) throw new Error("rpc exploded");
    on({ step: "deploy-resolver", phase: "done", txHash: "0xaaa" });
    on({ step: "register-agent", phase: "done", txHash: "0xbbb" });
    on({ step: "grant-keys", phase: "done", txHash: "0xccc" });
    this.creates.push(a);
    return { name: `${a.agentLabel}.${a.username}.nanitecom.eth`, resolver: `0x${"ab".repeat(20)}` };
  }
  async readSendPolicy(name: string) {
    return this.policies.get(name) ?? { policy: "reply-only" as const, allow: [], limit: 50 };
  }
  async setSendPolicy(a: { username: string; agentLabel: string; policy: string; allow?: string[] | undefined; limit?: number | undefined }, on: (e: AgentEvent) => void) {
    on({ step: "set-send-policy", phase: "start" });
    this.policyWrites.push(a);
    this.policies.set(`${a.agentLabel}.${a.username}.nanitecom.eth`, {
      policy: a.policy as "off",
      allow: a.allow ?? [],
      limit: a.limit ?? 50,
    });
    on({ step: "set-send-policy", phase: "done", txHash: "0xddd" });
  }
  retentionWrites: Array<Record<string, unknown>> = [];
  retention = new Map<string, { otpTtlMinutes: number; mailTtlHours: number; extend: string; extendLimit: number }>();
  async readRetentionPolicy(name: string) {
    const r = this.retention.get(name) ?? { otpTtlMinutes: 5, mailTtlHours: 48, extend: "on", extendLimit: 20 };
    return { ...r, extend: r.extend as "on" | "off", invalid: 0 };
  }
  async setRetentionPolicy(
    a: { username: string; agentLabel: string; otpTtlMinutes?: number; mailTtlHours?: number; extend?: string; extendLimit?: number },
    on: (e: AgentEvent) => void,
  ) {
    on({ step: "set-retention", phase: "start" });
    this.retentionWrites.push(a);
    const name = `${a.agentLabel}.${a.username}.nanitecom.eth`;
    const cur = await this.readRetentionPolicy(name);
    this.retention.set(name, {
      otpTtlMinutes: a.otpTtlMinutes ?? cur.otpTtlMinutes,
      mailTtlHours: a.mailTtlHours ?? cur.mailTtlHours,
      extend: a.extend ?? cur.extend,
      extendLimit: a.extendLimit ?? cur.extendLimit,
    });
    on({ step: "set-retention", phase: "done", txHash: "0xfff1" });
  }
  async revokeAgent(a: { agentLabel: string }, on: (e: AgentEvent) => void) {
    on({ step: "revoke-keys", phase: "start" });
    this.revokes.push(a.agentLabel);
    on({ step: "revoke-keys", phase: "done", txHash: "0xeee" });
  }
}

function makeApp(chain: AgentChain | undefined, opts: { masterKey?: Uint8Array | undefined } = { masterKey }) {
  return createApp({
    db: { ping: async () => void (await handle.client`select 1`) },
    webOrigin: ORIGIN,
    version: "t",
    log: () => undefined,
    auth: { db: handle.db, chainIds: [11155111], secureCookie: false },
    agents: { chain, masterKey: opts.masterKey, sharedMailDomain: DOMAIN },
  });
}
type App = ReturnType<typeof makeApp>;

const wallets: string[] = [];
beforeAll(() => ready());
afterAll(async () => {
  for (const w of wallets) await handle.db.delete(users).where(eq(users.walletAddress, w));
  await handle.db.delete(domains).where(eq(domains.name, DOMAIN));
  await handle.close();
});

const req = (app: App, cookie: string, path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { cookie, origin: ORIGIN, "content-type": "application/json", ...(init.headers ?? {}) } });
const post = (app: App, cookie: string, path: string, body?: unknown) =>
  req(app, cookie, path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function bundle() {
  await ready();
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

let userCounter = 0;
/** A signed-in user with keys and a claimed username (state set directly in the DB). */
async function onboardedUser(app: App) {
  const account = privateKeyToAccount(generatePrivateKey());
  const nonce = ((await (await app.request("/auth/nonce")).json()) as { nonce: string }).nonce;
  const message = createSiweMessage({
    address: account.address,
    chainId: 11155111,
    domain: "localhost:3000",
    nonce,
    uri: ORIGIN,
    version: "1",
    statement: "Sign in to Nanite",
  });
  const signature = await account.signMessage({ message });
  const res = await app.request("/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ message, signature }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  const wallet = account.address.toLowerCase();
  wallets.push(wallet);
  expect((await post(app, cookie, "/onboarding/keys", await bundle())).status).toBe(201);
  const username = `ag${SUFFIX}${userCounter++}`;
  await handle.db
    .update(users)
    .set({ username, ensName: `${username}.nanitecom.eth`, onboardingState: "done" })
    .where(eq(users.walletAddress, wallet));
  return { cookie, wallet, username };
}

const newWallet = () => privateKeyToAccount(generatePrivateKey()).address;

async function waitActive(app: App, cookie: string, id: string) {
  for (let i = 0; i < 100; i++) {
    const body = (await (await req(app, cookie, "/agents")).json()) as { agents: Array<{ id: string; status: string }> };
    const a = body.agents.find((x) => x.id === id);
    if (a && a.status !== "provisioning") return a.status;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("agent stayed provisioning");
}

async function addAgent(app: App, u: { cookie: string }, name: string, index: number) {
  const res = await post(app, u.cookie, "/agents", { name, index, walletAddress: newWallet() });
  return { res, body: (await res.json()) as Record<string, any> };
}

describe("POST /agents", () => {
  it("creates the agent, mailbox and token; the first email is routed; ENS job completes", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const wallet = newWallet();
    const res = await post(app, u.cookie, "/agents", { name: "Alex", index: 0, walletAddress: wallet });
    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(body.agent).toMatchObject({
      index: 0,
      name: "alex",
      ensName: `alex.${u.username}.nanitecom.eth`,
      email: `alex.${u.username}@${DOMAIN}`,
      walletAddress: wallet.toLowerCase(),
      status: "provisioning",
    });
    expect(Object.keys(body.agent).sort()).toEqual(["createdAt", "email", "ensName", "id", "index", "name", "status", "walletAddress"]);
    expect(Number.isNaN(Date.parse(body.agent.createdAt))).toBe(false);
    expect(body.token).toMatch(/^nan_[A-Za-z0-9_-]{43}$/);
    expect(res.headers.get("cache-control")).toBe("no-store");

    expect(await waitActive(app, u.cookie, body.agent.id)).toBe("active");
    expect(chain.creates).toHaveLength(1);
    expect(chain.creates[0]).toMatchObject({ username: u.username, agentLabel: "alex", agentWallet: wallet.toLowerCase() });
    expect(chain.creates[0]!.encryptionPublicKeyHex).toMatch(/^[0-9a-f]{64}$/);

    // The first email to the mailbox is routed (inbound uses findMailboxByAddress).
    const route = await findMailboxByAddress(handle.db, `Alex.${u.username}@${DOMAIN}`);
    expect(route?.agentId).toBe(body.agent.id);
    expect(route?.mailboxStatus).toBe("active");
    expect(route?.agentRevokedAt).toBeNull();

    // custody = nanite: sealed private key stored, never plaintext; public key matches ENS input.
    const [row] = await handle.db.select().from(agents).where(eq(agents.id, body.agent.id));
    expect(row!.custody).toBe("nanite");
    expect(row!.encryptedPrivateKey).not.toBeNull();
    expect(Buffer.from(row!.publicKey).toString("hex")).toBe(chain.creates[0]!.encryptionPublicKeyHex);
    expect(row!.resolverAddress).toBe(`0x${"ab".repeat(20)}`);
  });

  it("returns the token once; only its hash is stored; it authenticates the agent", async () => {
    const app = makeApp(new FakeAgentChain());
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "tok", 0);
    const token = body.token as string;
    const rows = await handle.db.select().from(apiTokens).where(eq(apiTokens.agentId, body.agent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect((await verifyAgentToken(handle.db, token, new Date())).ok).toBe(true);
    // Not retrievable afterwards.
    await waitActive(app, u.cookie, body.agent.id);
    for (const path of ["/agents", `/agents/${body.agent.id}/status`]) {
      expect(await (await req(app, u.cookie, path)).text()).not.toContain(token);
    }
  });

  it("validates index: must be the next free index", async () => {
    const app = makeApp(new FakeAgentChain());
    const u = await onboardedUser(app);
    const skip = await addAgent(app, u, "skip", 1);
    expect(skip.res.status).toBe(409);
    expect(skip.body).toEqual({ error: "index_mismatch", expected: 0 });
    expect((await addAgent(app, u, "first", 0)).res.status).toBe(202);
    const dup = await addAgent(app, u, "again", 0);
    expect(dup.res.status).toBe(409);
    expect(dup.body).toEqual({ error: "index_mismatch", expected: 1 });
    expect((await addAgent(app, u, "second", 1)).res.status).toBe(202);
    const bad = await post(app, u.cookie, "/agents", { name: "neg", index: -1, walletAddress: newWallet() });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe("invalid_index");
    expect((await post(app, u.cookie, "/agents", { name: "frac", index: 1.5, walletAddress: newWallet() })).status).toBe(400);
  });

  it("validates name and wallet; rejects duplicates", async () => {
    const app = makeApp(new FakeAgentChain());
    const u = await onboardedUser(app);
    for (const name of ["a", "-ab", "ab-", "has space", "UPPER_x", "x".repeat(33), "", "dot.ted"]) {
      const r = await post(app, u.cookie, "/agents", { name, index: 0, walletAddress: newWallet() });
      expect(r.status, name).toBe(400);
    }
    expect((await post(app, u.cookie, "/agents", { name: "okay", index: 0, walletAddress: "0x123" })).status).toBe(400);
    expect((await post(app, u.cookie, "/agents", { name: "okay", index: 0, walletAddress: u.wallet })).status).toBe(400);
    expect((await post(app, u.cookie, "/agents", { name: "okay", index: 0, walletAddress: newWallet(), encryptionPublicKey: "nope" })).status).toBe(400);
    expect((await addAgent(app, u, "dupe", 0)).res.status).toBe(202);
    const sameName = await addAgent(app, u, "dupe", 1);
    expect(sameName.res.status).toBe(409);
    expect(sameName.body.error).toBe("name_taken");
    const w = newWallet();
    expect((await post(app, u.cookie, "/agents", { name: "w1", index: 1, walletAddress: w })).status).toBe(202);
    const sameWallet = await post(app, u.cookie, "/agents", { name: "w2", index: 2, walletAddress: w });
    expect(sameWallet.status).toBe(409);
    expect(((await sameWallet.json()) as any).error).toBe("wallet_taken");
  });

  it("supports a self-custody agent via encryptionPublicKey (no private key stored)", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain, { masterKey: undefined });
    const u = await onboardedUser(app);
    const kp = await generateUserKeypair();
    const res = await post(app, u.cookie, "/agents", {
      name: "selfy",
      index: 0,
      walletAddress: newWallet(),
      encryptionPublicKey: Buffer.from(kp.publicKey).toString("base64"),
    });
    expect(res.status).toBe(202);
    const id = ((await res.json()) as any).agent.id as string;
    const [row] = await handle.db.select().from(agents).where(eq(agents.id, id));
    expect(row!.custody).toBe("self");
    expect(row!.encryptedPrivateKey).toBeNull();
    // without the master key a nanite-custody agent cannot be created
    const nokey = await post(app, u.cookie, "/agents", { name: "needskey", index: 1, walletAddress: newWallet() });
    expect(nokey.status).toBe(503);
    expect(((await nokey.json()) as any).error).toBe("master_key_not_configured");
  });

  it("503 operator_not_configured without the operator; 401 without a session; 403 bad origin; 409 before onboarding", async () => {
    const noOp = new FakeAgentChain();
    noOp.canWrite = false;
    const app = makeApp(noOp);
    const u = await onboardedUser(app);
    const r = await post(app, u.cookie, "/agents", { name: "noop", index: 0, walletAddress: newWallet() });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error).toBe("operator_not_configured");
    expect((await makeApp(undefined).request("/agents")).status).toBe(401);
    expect((await app.request("/agents", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(401);

    const ok = makeApp(new FakeAgentChain());
    const u2 = await onboardedUser(ok);
    const evil = await ok.request("/agents", {
      method: "POST",
      headers: { cookie: u2.cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "evil", index: 0, walletAddress: newWallet() }),
    });
    expect(evil.status).toBe(403);
    await handle.db.update(users).set({ onboardingState: "keys_created", ensName: null }).where(eq(users.walletAddress, u2.wallet));
    const early = await post(ok, u2.cookie, "/agents", { name: "early", index: 0, walletAddress: newWallet() });
    expect(early.status).toBe(409);
    expect(((await early.json()) as any).error).toBe("onboarding_incomplete");
  });

  it("GET /usage needs a session and returns counts only", async () => {
    const app = makeApp(new FakeAgentChain());
    expect((await app.request("/usage")).status).toBe(401);
    const u = await onboardedUser(app);
    const res = await req(app, u.cookie, "/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["date", "quota", "received", "sent"]);
    expect(body.date).toBe(new Date().toISOString().slice(0, 10));
    expect(body.quota).toBe(90);
    expect(Number.isInteger(body.sent) && Number.isInteger(body.received)).toBe(true);
  });

  it("a failed ENS job shows status failed and can be retried", async () => {
    const chain = new FakeAgentChain();
    chain.failCreate = true;
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "flaky", 0);
    expect(await waitActive(app, u.cookie, body.agent.id)).toBe("failed");
    const st = (await (await req(app, u.cookie, `/agents/${body.agent.id}/status`)).json()) as any;
    expect(st).toMatchObject({ agentStatus: "failed", kind: "create", status: "error" });
    expect(st.steps.map((s: any) => s.id)).toEqual(["deploy-resolver", "register-agent", "grant-keys", "publish-signer"]);
    chain.failCreate = false;
    expect((await post(app, u.cookie, `/agents/${body.agent.id}/retry`)).status).toBe(202);
    expect(await waitActive(app, u.cookie, body.agent.id)).toBe("active");
    expect((await post(app, u.cookie, `/agents/${body.agent.id}/retry`)).status).toBe(409);
  });
});

describe("GET /agents and status", () => {
  it("lists only the caller's agents in the exact contract shape", async () => {
    const app = makeApp(new FakeAgentChain());
    const a = await onboardedUser(app);
    const b = await onboardedUser(app);
    const { body: ba } = await addAgent(app, a, "mine", 0);
    await addAgent(app, b, "theirs", 0);
    await waitActive(app, a.cookie, ba.agent.id);
    const list = (await (await req(app, a.cookie, "/agents")).json()) as any;
    expect(list.agents).toHaveLength(1);
    expect(list.agents[0]).toMatchObject({ id: ba.agent.id, name: "mine", status: "active" });
    const empty = makeApp(new FakeAgentChain());
    const c = await onboardedUser(empty);
    expect(await (await req(empty, c.cookie, "/agents")).json()).toEqual({ agents: [] });
  });

  it("status steps use the claim step shape", async () => {
    const app = makeApp(new FakeAgentChain());
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "steps", 0);
    await waitActive(app, u.cookie, body.agent.id);
    const st = (await (await req(app, u.cookie, `/agents/${body.agent.id}/status`)).json()) as any;
    expect(st.status).toBe("done");
    expect(st.steps).toEqual([
      { id: "deploy-resolver", label: expect.any(String), status: "done", txHash: "0xaaa" },
      { id: "register-agent", label: expect.any(String), status: "done", txHash: "0xbbb" },
      { id: "grant-keys", label: expect.any(String), status: "done", txHash: "0xccc" },
      { id: "publish-signer", label: expect.any(String), status: "done", txHash: "0xfff" },
    ]);
  });
});

describe("ownership: user A cannot touch user B's agent", () => {
  it("returns 404 for every per-agent route", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const a = await onboardedUser(app);
    const b = await onboardedUser(app);
    const { body } = await addAgent(app, b, "bobs", 0);
    await waitActive(app, b.cookie, body.agent.id);
    const id = body.agent.id as string;
    const before = chain.policyWrites.length;
    const checks: Array<[string, string, unknown?]> = [
      ["GET", `/agents/${id}/status`],
      ["GET", `/agents/${id}/send-policy`],
      ["PUT", `/agents/${id}/send-policy`, { policy: "any" }],
      ["GET", `/agents/${id}/retention`],
      ["PUT", `/agents/${id}/retention`, { mailTtlHours: 100 }],
      ["POST", `/agents/${id}/token`],
      ["POST", `/agents/${id}/revoke`],
      ["POST", `/agents/${id}/retry`],
      ["GET", `/agents/not-a-uuid/status`],
    ];
    for (const [method, path, payload] of checks) {
      const r = await req(app, a.cookie, path, { method, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    expect(chain.policyWrites.length).toBe(before);
    expect(chain.retentionWrites).toHaveLength(0);
    expect(chain.revokes).toEqual([]);
    const [row] = await handle.db.select().from(agents).where(eq(agents.id, id));
    expect(row!.revokedAt).toBeNull();
    const toks = await handle.db.select().from(apiTokens).where(eq(apiTokens.agentId, id));
    expect(toks.every((t) => t.revokedAt === null)).toBe(true);
  });
});

describe("send policy", () => {
  it("GET reads fresh; PUT validates, lowercases and writes through the operator", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "poly", 0);
    await waitActive(app, u.cookie, body.agent.id);
    const id = body.agent.id as string;
    expect(await (await req(app, u.cookie, `/agents/${id}/send-policy`)).json()).toEqual({ policy: "reply-only", allow: [], limit: 50 });

    const put = await req(app, u.cookie, `/agents/${id}/send-policy`, {
      method: "PUT",
      body: JSON.stringify({ policy: "allowlist", allow: [" Friend@Example.COM ", "@Example.org", "Vitalik.eth", "friend@example.com"], limit: 7 }),
    });
    expect(put.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(chain.policyWrites.at(-1)).toMatchObject({
      agentLabel: "poly",
      policy: "allowlist",
      allow: ["friend@example.com", "@example.org", "vitalik.eth"],
      limit: 7,
    });
    expect(await (await req(app, u.cookie, `/agents/${id}/send-policy`)).json()).toEqual({
      policy: "allowlist",
      allow: ["friend@example.com", "@example.org", "vitalik.eth"],
      limit: 7,
    });
    const st = (await (await req(app, u.cookie, `/agents/${id}/status`)).json()) as any;
    expect(st).toMatchObject({ kind: "policy", status: "done" });
  });

  it("rejects invalid input without writing", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "valid", 0);
    await waitActive(app, u.cookie, body.agent.id);
    const url = `/agents/${body.agent.id}/send-policy`;
    const put = (b: unknown) => req(app, u.cookie, url, { method: "PUT", body: JSON.stringify(b) });
    expect((await put({ policy: "everything" })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await put({ policy: "any", allow: "a@b.co" })).status).toBe(400);
    expect((await put({ policy: "allowlist", allow: ["not valid"] })).status).toBe(400);
    expect((await put({ policy: "allowlist", allow: ["a@b.co,c@d.co"] })).status).toBe(400);
    expect((await put({ policy: "allowlist", allow: [42] })).status).toBe(400);
    expect((await put({ policy: "allowlist", allow: Array.from({ length: 101 }, (_, i) => `u${i}@x.co`) })).status).toBe(400);
    expect((await put({ policy: "any", limit: -1 })).status).toBe(400);
    expect((await put({ policy: "any", limit: 1.5 })).status).toBe(400);
    expect((await put({ policy: "any", limit: 10_001 })).status).toBe(400);
    expect((await req(app, u.cookie, url, { method: "PUT", body: "{nope" })).status).toBe(400);
    expect(chain.policyWrites).toHaveLength(0);
    expect((await put({ policy: "off" })).status).toBe(202);
  });

  it("503 operator_not_configured when the operator cannot sign", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "nowrite", 0);
    await waitActive(app, u.cookie, body.agent.id);
    chain.canWrite = false;
    const r = await req(app, u.cookie, `/agents/${body.agent.id}/send-policy`, { method: "PUT", body: JSON.stringify({ policy: "off" }) });
    expect(r.status).toBe(503);
  });
});

describe("retention settings", () => {
  it("GET returns the defaults; PUT writes only the given fields through the operator and the job completes", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "keeper", 0);
    await waitActive(app, u.cookie, body.agent.id);
    const id = body.agent.id as string;
    expect(await (await req(app, u.cookie, `/agents/${id}/retention`)).json()).toEqual({
      otpTtlMinutes: 5,
      mailTtlHours: 48,
      extend: "on",
      extendLimit: 20,
    });
    const put = await req(app, u.cookie, `/agents/${id}/retention`, {
      method: "PUT",
      body: JSON.stringify({ mailTtlHours: 168, extend: "off" }),
    });
    expect(put.status).toBe(202);
    expect(((await put.json()) as { kind: string }).kind).toBe("retention");
    await new Promise((r) => setTimeout(r, 50));
    expect(chain.retentionWrites.at(-1)).toEqual({ username: u.username, agentLabel: "keeper", mailTtlHours: 168, extend: "off" });
    expect(await (await req(app, u.cookie, `/agents/${id}/retention`)).json()).toEqual({
      otpTtlMinutes: 5,
      mailTtlHours: 168,
      extend: "off",
      extendLimit: 20,
    });
    expect(await (await req(app, u.cookie, `/agents/${id}/status`)).json()).toMatchObject({ kind: "retention", status: "done" });
  });

  it("validates ranges and types, needs an Origin and the operator", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "ranges", 0);
    await waitActive(app, u.cookie, body.agent.id);
    const url = `/agents/${body.agent.id}/retention`;
    const put = (b: unknown) => req(app, u.cookie, url, { method: "PUT", body: JSON.stringify(b) });
    for (const bad of [
      {},
      { otpTtlMinutes: 0 },
      { otpTtlMinutes: 61 },
      { otpTtlMinutes: 1.5 },
      { otpTtlMinutes: "5" },
      { mailTtlHours: 0 },
      { mailTtlHours: 4381 },
      { extend: "maybe" },
      { extend: true },
      { extendLimit: -1 },
      { extendLimit: 1001 },
    ]) {
      expect((await put(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await req(app, u.cookie, url, { method: "PUT", body: "{nope" })).status).toBe(400);
    expect(chain.retentionWrites).toHaveLength(0);
    expect((await req(app, u.cookie, url, { method: "PUT", headers: { origin: "https://evil.example" }, body: JSON.stringify({ extend: "on" }) })).status).toBe(403);
    expect((await app.request(url, { method: "PUT", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ extend: "on" }) })).status).toBe(401);
    expect((await put({ otpTtlMinutes: 60, mailTtlHours: 4380, extend: "on", extendLimit: 0 })).status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    chain.canWrite = false;
    expect((await put({ extend: "off" })).status).toBe(503);
  });
});

describe("token rotation and revoke", () => {
  it("rotates: the old token stops working, the new one works and is shown once", async () => {
    const app = makeApp(new FakeAgentChain());
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "rot", 0);
    await waitActive(app, u.cookie, body.agent.id);
    const oldToken = body.token as string;
    const r = await post(app, u.cookie, `/agents/${body.agent.id}/token`);
    expect(r.status).toBe(201);
    const { token } = (await r.json()) as { token: string };
    expect(token).not.toBe(oldToken);
    expect((await verifyAgentToken(handle.db, oldToken, new Date())).ok).toBe(false);
    expect((await verifyAgentToken(handle.db, token, new Date())).ok).toBe(true);
    const rows = await handle.db.select().from(apiTokens).where(eq(apiTokens.agentId, body.agent.id));
    expect(rows.map((t) => t.tokenHash)).toContain(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("revoke cuts tokens and the mailbox immediately and removes ENS write access", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "gone", 0);
    await waitActive(app, u.cookie, body.agent.id);
    const id = body.agent.id as string;
    const r = await post(app, u.cookie, `/agents/${id}/revoke`);
    expect(r.status).toBe(202);
    expect(((await r.json()) as any).agent.status).toBe("revoked");
    await new Promise((res) => setTimeout(res, 50));
    expect(chain.revokes).toEqual(["gone"]);
    expect((await verifyAgentToken(handle.db, body.token, new Date())).ok).toBe(false);
    const route = await findMailboxByAddress(handle.db, `gone.${u.username}@${DOMAIN}`);
    expect(route?.agentRevokedAt).not.toBeNull();
    expect(route?.mailboxStatus).toBe("disabled");
    const list = (await (await req(app, u.cookie, "/agents")).json()) as any;
    expect(list.agents[0].status).toBe("revoked");
    // further changes are refused, revoke is idempotent
    expect((await post(app, u.cookie, `/agents/${id}/token`)).status).toBe(409);
    expect((await req(app, u.cookie, `/agents/${id}/send-policy`, { method: "PUT", body: JSON.stringify({ policy: "any" }) })).status).toBe(409);
    expect((await post(app, u.cookie, `/agents/${id}/revoke`)).status).toBe(200);
    expect(chain.revokes).toEqual(["gone"]);
  });
});

describe("mail signing (option B)", () => {
  const sealedOf = async (id: string) => {
    const [row] = await handle.db.select().from(agents).where(eq(agents.id, id));
    return row!;
  };
  const unsealHex = async (id: string) => {
    const row = await sealedOf(id);
    const bytes = await unsealAgentSignerKey(masterKey, id, new Uint8Array(row.signerKeySealed!));
    return Buffer.from(bytes).toString("hex");
  };
  const waitJob = async (app: App, cookie: string, id: string, kind: string) => {
    for (let i = 0; i < 100; i++) {
      const st = (await (await req(app, cookie, `/agents/${id}/status`)).json()) as any;
      if (st.kind === kind && (st.status === "done" || st.status === "error")) return st;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("job did not finish");
  };
  const getSigner = async (app: App, cookie: string, id: string) => (await (await req(app, cookie, `/agents/${id}/signer`)).json()) as any;

  it("create generates and seals a signer key, then publishes the address as a job step", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "signy", 0);
    expect(await waitActive(app, u.cookie, body.agent.id)).toBe("active");
    const id = body.agent.id as string;
    const row = await sealedOf(id);
    expect(row.signerAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(row.signerKeySealed).not.toBeNull();
    const hex = await unsealHex(id);
    expect(privateKeyToAddress(`0x${hex}`).toLowerCase()).toBe(row.signerAddress);
    // The signer key and the encryption key are sealed under different labels: neither blob unseals as the other.
    await expect(unsealAgentPrivateKey(masterKey, id, new Uint8Array(row.signerKeySealed!))).rejects.toThrow();
    await expect(unsealAgentSignerKey(masterKey, id, new Uint8Array(row.encryptedPrivateKey!))).rejects.toThrow();
    // ... and a blob moved to another agent id does not unseal either.
    await expect(unsealAgentSignerKey(masterKey, randomUUID(), new Uint8Array(row.signerKeySealed!))).rejects.toThrow();

    expect(chain.publishes).toEqual([{ agentLabel: "signy", address: getAddress(row.signerAddress!) }]);
    expect(chain.signerRecords.get(`signy.${u.username}.nanitecom.eth`)).toBe(getAddress(row.signerAddress!));
    const st = await waitJob(app, u.cookie, id, "create");
    expect(st.steps.at(-1)).toMatchObject({ id: "publish-signer", status: "done", txHash: "0xfff" });

    const info = await getSigner(app, u.cookie, id);
    expect(info).toEqual({ supported: true, custody: "nanite", managed: true, address: getAddress(row.signerAddress!), record: "published", onchain: getAddress(row.signerAddress!) });
    // No response ever carries the key (hex) or the sealed blob.
    const all = JSON.stringify([body, st, info, await (await req(app, u.cookie, "/agents")).json()]);
    expect(all).not.toContain(hex);
    expect(all).not.toContain(Buffer.from(row.signerKeySealed!).toString("base64"));
    expect(all).not.toContain(Buffer.from(row.signerKeySealed!).toString("hex"));
  });

  it("a failed publish leaves the job in error, the agent usable, and a retry (POST /signer) fixes it", async () => {
    const chain = new FakeAgentChain();
    chain.failPublish = true;
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "pubfail", 0);
    const id = body.agent.id as string;
    const st = await waitJob(app, u.cookie, id, "create");
    expect(st.status).toBe("error");
    expect(await waitActive(app, u.cookie, id)).toBe("active");
    expect((await getSigner(app, u.cookie, id)).record).toBe("pending");
    chain.failPublish = false;
    const r = await post(app, u.cookie, `/agents/${id}/signer`);
    expect(r.status).toBe(202);
    expect((await waitJob(app, u.cookie, id, "signer")).status).toBe("done");
    expect((await getSigner(app, u.cookie, id)).record).toBe("published");
  });

  it("self-custody agents without a signerAddress have no signer: columns stay null, no step, POST /signer needs an address", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const kp = await generateUserKeypair();
    const res = await post(app, u.cookie, "/agents", {
      name: "selfsign",
      index: 0,
      walletAddress: newWallet(),
      encryptionPublicKey: Buffer.from(kp.publicKey).toString("base64"),
    });
    const id = ((await res.json()) as any).agent.id as string;
    expect(await waitActive(app, u.cookie, id)).toBe("active");
    const row = await sealedOf(id);
    expect(row.signerAddress).toBeNull();
    expect(row.signerKeySealed).toBeNull();
    expect(chain.publishes).toEqual([]);
    const st = await waitJob(app, u.cookie, id, "create");
    expect(st.steps.map((s: any) => s.id)).toEqual(["deploy-resolver", "register-agent", "grant-keys"]);
    expect(await getSigner(app, u.cookie, id)).toEqual({ supported: true, custody: "self", managed: false, address: null, record: "none", onchain: null });
    const r = await post(app, u.cookie, `/agents/${id}/signer`);
    expect(r.status).toBe(400); // a self-hosted agent must say which address to publish
    expect(((await r.json()) as any).error).toBe("invalid_signer");
    expect(chain.publishes).toEqual([]);
  });

  it("self-hosted agent: signerAddress is published as nanite.signer, no key is stored; POST /signer {address} rotates it", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const kp = await generateUserKeypair();
    const signer = privateKeyToAccount(generatePrivateKey()).address;
    const res = await post(app, u.cookie, "/agents", {
      name: "selfhost",
      index: 0,
      walletAddress: newWallet(),
      encryptionPublicKey: Buffer.from(kp.publicKey).toString("base64"),
      signerAddress: signer.toLowerCase(),
    });
    expect(res.status).toBe(202);
    const id = ((await res.json()) as any).agent.id as string;
    expect(await waitActive(app, u.cookie, id)).toBe("active");
    const row = await sealedOf(id);
    expect(row.custody).toBe("self");
    expect(row.signerAddress).toBe(signer.toLowerCase());
    expect(row.signerKeySealed).toBeNull();
    expect(row.encryptedPrivateKey).toBeNull();
    expect(chain.publishes).toEqual([{ agentLabel: "selfhost", address: signer }]);
    expect((await waitJob(app, u.cookie, id, "create")).steps.at(-1)).toMatchObject({ id: "publish-signer", status: "done" });
    expect(await getSigner(app, u.cookie, id)).toEqual({ supported: true, custody: "self", managed: false, address: signer, record: "published", onchain: signer });

    // Rotate: the new address is published first, then stored; still no key on the server.
    const next = privateKeyToAccount(generatePrivateKey()).address;
    const r = await post(app, u.cookie, `/agents/${id}/signer`, { address: next });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ kind: "signer", rotated: true, signerAddress: next });
    expect((await waitJob(app, u.cookie, id, "signer")).status).toBe("done");
    const after = await sealedOf(id);
    expect(after.signerAddress).toBe(next.toLowerCase());
    expect(after.signerKeySealed).toBeNull();
    expect(chain.signerRecords.get(`selfhost.${u.username}.nanitecom.eth`)).toBe(next);

    // A failed publish keeps the old address.
    chain.failPublish = true;
    const again = privateKeyToAccount(generatePrivateKey()).address;
    await post(app, u.cookie, `/agents/${id}/signer`, { address: again });
    expect((await waitJob(app, u.cookie, id, "signer")).status).toBe("error");
    expect((await sealedOf(id)).signerAddress).toBe(next.toLowerCase());
  });

  it("signerAddress validation: needs a self-custody agent and a real address", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const kp = await generateUserKeypair();
    const base = { name: "badsigner", index: 0, walletAddress: newWallet() };
    const pk = Buffer.from(kp.publicKey).toString("base64");
    const noSelf = await post(app, u.cookie, "/agents", { ...base, signerAddress: privateKeyToAccount(generatePrivateKey()).address });
    expect(noSelf.status).toBe(400);
    expect(((await noSelf.json()) as any).error).toBe("signer_requires_self_custody");
    for (const bad of ["0x123", 5, "not-an-address", ""]) {
      const r = await post(app, u.cookie, "/agents", { ...base, encryptionPublicKey: pk, signerAddress: bad });
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error).toBe("invalid_signer");
    }
    expect(chain.creates).toEqual([]);
  });

  it("existing agents without a signer get one via POST /signer; a second call rotates it", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "legacy", 0);
    const id = body.agent.id as string;
    await waitActive(app, u.cookie, id);
    await waitJob(app, u.cookie, id, "create");
    // Simulate an agent created before signing existed.
    await handle.db.update(agents).set({ signerAddress: null, signerKeySealed: null }).where(eq(agents.id, id));
    chain.signerRecords.clear();
    chain.publishes.length = 0;
    expect(await getSigner(app, u.cookie, id)).toEqual({ supported: true, custody: "nanite", managed: true, address: null, record: "none", onchain: null });

    const r1 = await post(app, u.cookie, `/agents/${id}/signer`);
    expect(r1.status).toBe(202);
    const b1 = (await r1.json()) as any;
    expect(b1).toMatchObject({ kind: "signer", rotated: false });
    expect(b1.steps.map((s: any) => s.id)).toEqual(["publish-signer"]);
    expect((await waitJob(app, u.cookie, id, "signer")).status).toBe("done");
    const first = (await sealedOf(id)).signerAddress!;
    expect(first).toBe(b1.signerAddress.toLowerCase());
    expect(await getSigner(app, u.cookie, id)).toMatchObject({ address: getAddress(first), record: "published" });
    const firstHex = await unsealHex(id);

    const r2 = await post(app, u.cookie, `/agents/${id}/signer`);
    expect(r2.status).toBe(202);
    expect(((await r2.json()) as any).rotated).toBe(true);
    expect((await waitJob(app, u.cookie, id, "signer")).status).toBe("done");
    const second = (await sealedOf(id)).signerAddress!;
    expect(second).not.toBe(first);
    expect(await unsealHex(id)).not.toBe(firstHex);
    expect(chain.publishes.map((p) => p.address.toLowerCase())).toEqual([first, second]);
    expect(chain.signerRecords.get(`legacy.${u.username}.nanitecom.eth`)).toBe(getAddress(second));
    expect(await getSigner(app, u.cookie, id)).toMatchObject({ address: getAddress(second), record: "published" });
  });

  it("a failed rotation keeps the old key and the old record (nothing switches before ENS has the new address)", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "keepold", 0);
    const id = body.agent.id as string;
    await waitActive(app, u.cookie, id);
    const before = await sealedOf(id);
    chain.failPublish = true;
    expect((await post(app, u.cookie, `/agents/${id}/signer`)).status).toBe(202);
    expect((await waitJob(app, u.cookie, id, "signer")).status).toBe("error");
    const after = await sealedOf(id);
    expect(after.signerAddress).toBe(before.signerAddress);
    expect(Buffer.from(after.signerKeySealed!).equals(Buffer.from(before.signerKeySealed!))).toBe(true);
    expect((await getSigner(app, u.cookie, id)).record).toBe("published");
  });

  it("GET /signer reports published / pending / mismatch / unavailable from a fresh ENS read", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "states", 0);
    const id = body.agent.id as string;
    await waitActive(app, u.cookie, id);
    const name = `states.${u.username}.nanitecom.eth`;
    const mine = getAddress((await sealedOf(id)).signerAddress!);
    expect((await getSigner(app, u.cookie, id)).record).toBe("published");
    chain.signerRecords.set(name, getAddress("0x000000000000000000000000000000000000dEaD"));
    expect(await getSigner(app, u.cookie, id)).toMatchObject({ record: "mismatch", address: mine, onchain: getAddress("0x000000000000000000000000000000000000dEaD") });
    chain.signerRecords.delete(name);
    expect(await getSigner(app, u.cookie, id)).toMatchObject({ record: "pending", onchain: null });
    chain.readFails = true;
    expect((await getSigner(app, u.cookie, id)).record).toBe("unavailable");
  });

  it("ownership: user B cannot read or rotate user A's signer; Origin and session are enforced", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const a = await onboardedUser(app);
    const b = await onboardedUser(app);
    const { body } = await addAgent(app, a, "owned", 0);
    const id = body.agent.id as string;
    await waitActive(app, a.cookie, id);
    const before = await sealedOf(id);
    const n = chain.publishes.length;
    expect((await req(app, b.cookie, `/agents/${id}/signer`)).status).toBe(404);
    expect((await post(app, b.cookie, `/agents/${id}/signer`)).status).toBe(404);
    expect((await post(app, b.cookie, `/agents/not-a-uuid/signer`)).status).toBe(404);
    const evil = await app.request(`/agents/${id}/signer`, { method: "POST", headers: { cookie: a.cookie, origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    expect((await app.request(`/agents/${id}/signer`, { method: "POST", headers: { origin: ORIGIN } })).status).toBe(401);
    expect(chain.publishes.length).toBe(n);
    const after = await sealedOf(id);
    expect(after.signerAddress).toBe(before.signerAddress);
    expect(Buffer.from(after.signerKeySealed!).equals(Buffer.from(before.signerKeySealed!))).toBe(true);
  });

  it("POST /signer: 503 without the operator or master key, 409 for a revoked agent", async () => {
    const chain = new FakeAgentChain();
    const app = makeApp(chain);
    const u = await onboardedUser(app);
    const { body } = await addAgent(app, u, "guards", 0);
    const id = body.agent.id as string;
    await waitActive(app, u.cookie, id);
    const noMaster = makeApp(chain, { masterKey: undefined });
    expect((await post(noMaster, u.cookie, `/agents/${id}/signer`)).status).toBe(503);
    chain.canWrite = false;
    expect((await post(app, u.cookie, `/agents/${id}/signer`)).status).toBe(503);
    chain.canWrite = true;
    await post(app, u.cookie, `/agents/${id}/revoke`);
    const r = await post(app, u.cookie, `/agents/${id}/signer`);
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toBe("agent_revoked");
  });
});
