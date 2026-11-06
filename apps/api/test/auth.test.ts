import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateNaniteSeed, generateSalt, generateUserKeypair, keyId, ready, wrapSecret } from "@nanite/crypto";
import { authNonces, createDb, userKeys, users } from "@nanite/db";
import { eq } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { createApp } from "../src/app.js";
import type { ClaimEvent, UserNameChain } from "../src/auth/types.js";
import { checkUsernameFormat } from "../src/routes/onboarding.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
const ORIGIN = "http://localhost:3000";
const handle = createDb(DATABASE_URL, { max: 2 });
const logs: string[] = [];

class FakeChain implements UserNameChain {
  canClaim = true;
  registered = new Map<string, string>();
  calls = 0;
  failOnce = false;
  gate: Promise<void> | null = null;
  async lookup(u: string) {
    const owner = this.registered.get(u);
    return owner ? { status: "registered" as const, owner } : { status: "available" as const };
  }
  async createUserName(a: { username: string; userWallet: string }, on: (e: ClaimEvent) => void) {
    this.calls++;
    on({ step: "deploy-registry", phase: "start" });
    if (this.gate) await this.gate;
    on({ step: "deploy-registry", phase: "done", txHash: "0xaaa" });
    if (this.failOnce) {
      this.failOnce = false;
      on({ step: "set-parent", phase: "start" });
      throw new Error("rpc exploded");
    }
    on({ step: "set-parent", phase: "done", txHash: "0xbbb" });
    on({ step: "register-username", phase: "done", txHash: "0xccc" });
    this.registered.set(a.username, a.userWallet);
    return { name: `${a.username}.nanitecom.eth` };
  }
}

function makeApp(chain?: UserNameChain, chainIds = [11155111], secure = false) {
  return createApp({
    db: { ping: async () => void (await handle.client`select 1`) },
    webOrigin: ORIGIN,
    version: "t",
    log: (l) => logs.push(l),
    auth: { db: handle.db, chainIds, secureCookie: secure, ...(chain ? { chain } : {}) },
  });
}
type App = ReturnType<typeof makeApp>;

async function getNonce(app: App) {
  return ((await (await app.request("/auth/nonce")).json()) as { nonce: string }).nonce;
}

function siwe(account: ReturnType<typeof privateKeyToAccount>, nonce: string, o: { domain?: string; chainId?: number; uri?: string } = {}) {
  return createSiweMessage({
    address: account.address,
    chainId: o.chainId ?? 11155111,
    domain: o.domain ?? "localhost:3000",
    nonce,
    uri: o.uri ?? ORIGIN,
    version: "1",
    statement: "Sign in to Nanite",
  });
}

async function signIn(app: App, account = privateKeyToAccount(generatePrivateKey()), o: Parameters<typeof siwe>[2] = {}) {
  const nonce = await getNonce(app);
  const message = siwe(account, nonce, o);
  const signature = await account.signMessage({ message });
  const res = await app.request("/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ message, signature }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { res, cookie, account, nonce, message, signature };
}

const authed = (app: App, cookie: string, path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { cookie, origin: ORIGIN, "content-type": "application/json", ...(init.headers ?? {}) } });

async function bundle(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

const wallets: string[] = [];
beforeAll(() => ready());
afterAll(async () => {
  for (const w of wallets) await handle.db.delete(users).where(eq(users.walletAddress, w));
  await handle.close();
});
async function newUser(app: App) {
  const s = await signIn(app);
  wallets.push(s.account.address.toLowerCase());
  return s;
}

describe("SIWE sign-in", () => {
  it("rejects unauthenticated /me", async () => {
    expect((await makeApp().request("/me")).status).toBe(401);
  });

  it("happy path: session cookie flags, /me, logout", async () => {
    const app = makeApp();
    const s = await newUser(app);
    expect(s.res.status).toBe(200);
    const sc = s.res.headers.get("set-cookie")!;
    expect(sc).toMatch(/^nanite_session=[0-9a-f-]{36}/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/Secure/i); // dev
    const me = await authed(app, s.cookie, "/me");
    expect(await me.json()).toEqual({
      wallet: s.account.address.toLowerCase(),
      username: null,
      ensName: null,
      onboardingState: "started",
      hasKeys: false,
    });
    expect((await authed(app, s.cookie, "/auth/logout", { method: "POST" })).status).toBe(200);
    expect((await authed(app, s.cookie, "/me")).status).toBe(401);
  });

  it("sets Secure in production mode", async () => {
    const app = makeApp(undefined, [11155111], true);
    const s = await newUser(app);
    expect(s.res.headers.get("set-cookie")).toMatch(/Secure/i);
  });

  it("nonce is single use", async () => {
    const app = makeApp();
    const s = await newUser(app);
    const again = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: s.message, signature: s.signature }),
    });
    expect(again.status).toBe(401);
    expect(((await again.json()) as { reason: string }).reason).toBe("nonce");
  });

  it("expired nonce is rejected", async () => {
    const app = makeApp();
    const account = privateKeyToAccount(generatePrivateKey());
    const nonce = await getNonce(app);
    await handle.db.update(authNonces).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authNonces.nonce, nonce));
    const message = siwe(account, nonce);
    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
    });
    expect(res.status).toBe(401);
  });

  it("unknown nonce, wrong domain, wrong chain, wrong uri, bad signature are rejected", async () => {
    const app = makeApp();
    const account = privateKeyToAccount(generatePrivateKey());
    const post = async (message: string, signature: string) =>
      app.request("/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) });
    const reason = async (r: Response) => ((await r.json()) as { reason: string }).reason;

    const m1 = siwe(account, "deadbeefdeadbeef");
    expect(await reason(await post(m1, await account.signMessage({ message: m1 })))).toBe("nonce");

    const m2 = siwe(account, await getNonce(app), { domain: "evil.example" });
    expect(await reason(await post(m2, await account.signMessage({ message: m2 })))).toBe("domain");

    const m3 = siwe(account, await getNonce(app), { chainId: 1 });
    expect(await reason(await post(m3, await account.signMessage({ message: m3 })))).toBe("chain");

    const m4 = siwe(account, await getNonce(app), { uri: "https://evil.example" });
    expect(await reason(await post(m4, await account.signMessage({ message: m4 })))).toBe("uri");

    const other = privateKeyToAccount(generatePrivateKey());
    const m5 = siwe(account, await getNonce(app));
    expect(await reason(await post(m5, await other.signMessage({ message: m5 })))).toBe("signature");

    expect((await post(m5, "0x1234")).status).toBe(400);
    expect((await app.request("/auth/verify", { method: "POST", headers: { origin: "http://evil.example", "content-type": "application/json" }, body: "{}" })).status).toBe(403);
  });

  it("accepts a configured alternative chain id", async () => {
    const app = makeApp(undefined, [31337]);
    const s = await signIn(app, privateKeyToAccount(generatePrivateKey()), { chainId: 31337 });
    wallets.push(s.account.address.toLowerCase());
    expect(s.res.status).toBe(200);
  });

  it("lowercases the wallet before insert", async () => {
    const app = makeApp();
    const s = await newUser(app);
    const rows = await handle.db.select().from(users).where(eq(users.walletAddress, s.account.address.toLowerCase()));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.username.startsWith("pending-")).toBe(true);
  });
});

describe("onboarding keys", () => {
  it("requires a session", async () => {
    const app = makeApp();
    expect((await app.request("/onboarding/keys", { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("stores the bundle, advances state, returns it, and refuses a second upload", async () => {
    const app = makeApp();
    const s = await newUser(app);
    const b = await bundle();
    const res = await authed(app, s.cookie, "/onboarding/keys", { method: "POST", body: JSON.stringify(b) });
    expect(res.status).toBe(201);
    const me = (await (await authed(app, s.cookie, "/me")).json()) as { onboardingState: string; hasKeys: boolean };
    expect(me).toMatchObject({ onboardingState: "keys_created", hasKeys: true });
    const got = (await (await authed(app, s.cookie, "/onboarding/keys")).json()) as Record<string, unknown>;
    expect(got).toMatchObject(b);
    expect((await authed(app, s.cookie, "/onboarding/keys", { method: "POST", body: JSON.stringify(await bundle()) })).status).toBe(409);
  });

  it("rejects unknown fields (nothing extra is persisted), bad sizes, wrong keyId, oversize payloads", async () => {
    const app = makeApp();
    const s = await newUser(app);
    const post = (body: unknown) => authed(app, s.cookie, "/onboarding/keys", { method: "POST", body: JSON.stringify(body) });
    const b = await bundle();
    const withSig = await post({ ...b, signature: "0xabc" });
    expect(withSig.status).toBe(400);
    expect(await withSig.json()).toMatchObject({ error: "unknown_field", field: "signature" });
    for (const f of ["recoveryCode", "seed", "privateKey", "passphrase"]) expect((await post({ ...b, [f]: "x" })).status).toBe(400);
    expect(await (await post({ ...b, publicKey: Buffer.alloc(31).toString("base64") })).json()).toMatchObject({ field: "publicKey" });
    expect(await (await post({ ...b, walletSalt: Buffer.alloc(15).toString("base64") })).json()).toMatchObject({ field: "walletSalt" });
    expect(await (await post({ ...b, wrappedSeedWallet: Buffer.alloc(72).toString("base64") })).json()).toMatchObject({ field: "wrappedSeedWallet" });
    expect(await (await post({ ...b, passphraseMode: "yes" })).json()).toMatchObject({ field: "passphraseMode" });
    expect(await (await post({ ...b, keyId: "0".repeat(16) })).json()).toMatchObject({ field: "keyId" });
    const big = await post({ ...b, padding: "x".repeat(10_000) });
    expect(big.status).toBe(413);
    const rows = await handle.db.select().from(userKeys).innerJoin(users, eq(users.id, userKeys.userId)).where(eq(users.walletAddress, s.account.address.toLowerCase()));
    expect(rows).toHaveLength(0);
  });
});

describe("usernames", () => {
  it("validates format", () => {
    expect(checkUsernameFormat("alice")).toEqual({ ok: true });
    expect(checkUsernameFormat("ab")).toMatchObject({ ok: false });
    expect(checkUsernameFormat("-abc")).toMatchObject({ ok: false });
    expect(checkUsernameFormat("Abc")).toMatchObject({ ok: false });
    expect(checkUsernameFormat("a_bc")).toMatchObject({ ok: false });
    expect(checkUsernameFormat("a".repeat(33))).toMatchObject({ ok: false });
    expect(checkUsernameFormat("pending-abc")).toMatchObject({ ok: false, reason: "invalid" });
    expect(checkUsernameFormat("admin")).toEqual({ ok: false, reason: "reserved" });
  });

  it("availability checks format, DB and chain", async () => {
    const chain = new FakeChain();
    const app = makeApp(chain);
    const s = await newUser(app);
    const avail = async (n: string) => (await (await authed(app, s.cookie, `/onboarding/username/${n}/available`)).json()) as { available: boolean; reason?: string };
    expect(await avail("free-name-1")).toEqual({ username: "free-name-1", available: true });
    expect(await avail("x")).toMatchObject({ available: false, reason: "invalid" });
    expect(await avail("admin")).toMatchObject({ available: false, reason: "reserved" });
    chain.registered.set("onchain-taken", "0x" + "9".repeat(40));
    expect(await avail("onchain-taken")).toMatchObject({ available: false, reason: "taken" });
  });
});

describe("username claim", () => {
  async function ready2(chain: FakeChain) {
    const app = makeApp(chain);
    const s = await newUser(app);
    return { app, s };
  }
  const claim = (app: App, cookie: string, username: string) => authed(app, cookie, "/onboarding/username", { method: "POST", body: JSON.stringify({ username }) });
  const uname = () => "t" + Math.random().toString(36).slice(2, 10);

  it("needs keys first, and 503 without an operator", async () => {
    const chain = new FakeChain();
    const { app, s } = await ready2(chain);
    expect((await claim(app, s.cookie, uname())).status).toBe(409);
    await authed(app, s.cookie, "/onboarding/keys", { method: "POST", body: JSON.stringify(await bundle()) });
    chain.canClaim = false;
    const res = await claim(app, s.cookie, uname());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "operator_not_configured" });
    const noChain = makeApp();
    expect((await claim(noChain, s.cookie, uname())).status).toBe(503);
  });

  it("claims in the background, exposes progress, reaches name_claimed, then done", async () => {
    const chain = new FakeChain();
    let release!: () => void;
    chain.gate = new Promise((r) => (release = r));
    const { app, s } = await ready2(chain);
    await authed(app, s.cookie, "/onboarding/keys", { method: "POST", body: JSON.stringify(await bundle()) });
    const name = uname();
    const res = await claim(app, s.cookie, name);
    expect(res.status).toBe(202);
    await vi.waitFor(async () => {
      const st = (await (await authed(app, s.cookie, "/onboarding/status")).json()) as { claim: { status: string; steps: { id: string; status: string }[] } };
      expect(st.claim.status).toBe("running");
      expect(st.claim.steps[0]!.status).toBe("active");
    });
    // second POST while running is idempotent for the same name, 409 for another
    expect((await claim(app, s.cookie, name)).status).toBe(202);
    expect((await claim(app, s.cookie, uname())).status).toBe(409);
    release();
    await vi.waitFor(async () => {
      const st = (await (await authed(app, s.cookie, "/onboarding/status")).json()) as { onboardingState: string; ensName: string; claim: { status: string; steps: { txHash?: string }[] } };
      expect(st.claim.status).toBe("done");
      expect(st.onboardingState).toBe("name_claimed");
      expect(st.ensName).toBe(`${name}.nanitecom.eth`);
      expect(st.claim.steps.map((x) => x.txHash)).toEqual(["0xaaa", "0xbbb", "0xccc"]);
    });
    expect((await authed(app, s.cookie, "/onboarding/complete", { method: "POST" })).status).toBe(200);
    expect(((await (await authed(app, s.cookie, "/me")).json()) as { username: string; onboardingState: string })).toMatchObject({ username: name, onboardingState: "done" });
  });

  it("is resumable: a failed job leaves keys_created and a retry completes", async () => {
    const chain = new FakeChain();
    chain.failOnce = true;
    const { app, s } = await ready2(chain);
    await authed(app, s.cookie, "/onboarding/keys", { method: "POST", body: JSON.stringify(await bundle()) });
    const name = uname();
    await claim(app, s.cookie, name);
    await vi.waitFor(async () => {
      const st = (await (await authed(app, s.cookie, "/onboarding/status")).json()) as { onboardingState: string; claim: { status: string; error: { code: string } | null } };
      expect(st.claim.status).toBe("error");
      expect(st.claim.error?.code).toBe("chain_error");
      expect(st.onboardingState).toBe("keys_created");
    });
    expect((await claim(app, s.cookie, name)).status).toBe(202);
    await vi.waitFor(async () => {
      const st = (await (await authed(app, s.cookie, "/onboarding/status")).json()) as { onboardingState: string };
      expect(st.onboardingState).toBe("name_claimed");
    });
    expect(chain.calls).toBe(2);
    expect((await claim(app, s.cookie, name)).status).toBe(409); // already claimed
  });

  it("refuses names taken in the DB or on chain", async () => {
    const chain = new FakeChain();
    const { app, s } = await ready2(chain);
    await authed(app, s.cookie, "/onboarding/keys", { method: "POST", body: JSON.stringify(await bundle()) });
    const name = uname();
    chain.registered.set(name, "0x" + "9".repeat(40));
    expect((await claim(app, s.cookie, name)).status).toBe(409);
    expect((await claim(app, s.cookie, "x")).status).toBe(400);
  });
});

describe("logs are clean", () => {
  it("never contain signatures, wrapped blobs, salts or messages", async () => {
    const spy = vi.spyOn(console, "log");
    const app = makeApp(new FakeChain());
    const before = logs.length;
    const s = await newUser(app);
    const b = await bundle();
    await authed(app, s.cookie, "/onboarding/keys", { method: "POST", body: JSON.stringify(b) });
    await authed(app, s.cookie, "/onboarding/keys");
    const all = logs.slice(before).join("\n") + spy.mock.calls.flat().join("\n");
    spy.mockRestore();
    expect(logs.length).toBeGreaterThan(before);
    for (const secret of [s.signature, s.message, s.nonce, s.cookie.split("=")[1]!, ...Object.values(b).filter((v): v is string => typeof v === "string" && v.length > 20)]) {
      expect(all).not.toContain(secret);
    }
  });
});
