import { keyId as computeKeyId, ready } from "@nanite/crypto";
import { getUserKeys, insertUserKeys, isPendingUsername, isUsernameTaken, markOnboardingDone, setUsername } from "@nanite/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createClaimRunner, type ClaimJob } from "../auth/jobs.js";
import { requireSession, type AuthVars } from "../auth/session.js";
import type { AuthDeps } from "../auth/types.js";

// ---- key bundle validation (everything binary travels as standard base64) ----
const KEY_FIELDS = [
  "publicKey",
  "keyId",
  "walletSalt",
  "recoverySalt",
  "wrappedPrivateKeyWallet",
  "wrappedPrivateKeyRecovery",
  "wrappedSeedWallet",
  "wrappedSeedRecovery",
  "passphraseMode",
] as const;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const WRAPPED_LEN = 1 + 24 + 32 + 16; // version || nonce || 32-byte secret || tag
const WRAPPED_VERSION = 1;

function b64(value: unknown, len: number): Buffer | null {
  if (typeof value !== "string" || value.length > 256 || !B64_RE.test(value)) return null;
  const buf = Buffer.from(value, "base64");
  return buf.length === len && buf.toString("base64") === value ? buf : null;
}

export function parseKeyBundle(body: unknown):
  | { ok: true; keys: Parameters<typeof insertUserKeys>[2] }
  | { ok: false; error: string; field?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid_request" };
  const o = body as Record<string, unknown>;
  const unknown = Object.keys(o).find((k) => !(KEY_FIELDS as readonly string[]).includes(k));
  if (unknown) return { ok: false, error: "unknown_field", field: unknown };
  const bad = (field: string) => ({ ok: false as const, error: "invalid_field", field });
  const publicKey = b64(o.publicKey, 32);
  if (!publicKey) return bad("publicKey");
  const walletSalt = b64(o.walletSalt, 16);
  if (!walletSalt) return bad("walletSalt");
  const recoverySalt = b64(o.recoverySalt, 16);
  if (!recoverySalt) return bad("recoverySalt");
  const wrapped: Record<string, Buffer> = {};
  for (const f of ["wrappedPrivateKeyWallet", "wrappedPrivateKeyRecovery", "wrappedSeedWallet", "wrappedSeedRecovery"]) {
    const buf = b64(o[f], WRAPPED_LEN);
    if (!buf || buf[0] !== WRAPPED_VERSION) return bad(f);
    wrapped[f] = buf;
  }
  if (typeof o.passphraseMode !== "boolean") return bad("passphraseMode");
  if (typeof o.keyId !== "string" || !/^[0-9a-f]{16}$/.test(o.keyId)) return bad("keyId");
  return {
    ok: true,
    keys: {
      publicKey,
      keyId: o.keyId,
      walletSalt,
      recoverySalt,
      wrappedPrivateKeyWallet: wrapped.wrappedPrivateKeyWallet!,
      wrappedPrivateKeyRecovery: wrapped.wrappedPrivateKeyRecovery!,
      wrappedSeedWallet: wrapped.wrappedSeedWallet!,
      wrappedSeedRecovery: wrapped.wrappedSeedRecovery!,
      passphraseMode: o.passphraseMode,
    },
  };
}

// ---- usernames ----
const USERNAME_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const RESERVED = new Set([
  "admin", "administrator", "api", "app", "root", "nanite", "nanitecom", "www", "mail", "email", "support", "help",
  "security", "abuse", "postmaster", "hostmaster", "webmaster", "noreply", "no-reply", "info", "team", "ens", "eth",
  "operator", "system", "test", "demo", "agent", "agents", "status", "billing", "docs", "blog",
]);

export type UsernameCheck = { ok: true } | { ok: false; reason: "invalid" | "reserved" };
export function checkUsernameFormat(name: string): UsernameCheck {
  if (name.length < 3 || name.length > 32 || !USERNAME_RE.test(name) || isPendingUsername(name)) return { ok: false, reason: "invalid" };
  if (RESERVED.has(name)) return { ok: false, reason: "reserved" };
  return { ok: true };
}

const claimBody = (job: ClaimJob | undefined, fallback?: { username: string | null; state: string }) =>
  job
    ? { status: job.status, username: job.username, steps: job.steps, error: job.error ?? null }
    : { status: fallback && (fallback.state === "name_claimed" || fallback.state === "done") ? "done" : "idle", username: fallback?.username ?? null, steps: [], error: null };

export function onboardingRoutes(deps: AuthDeps, webOrigin: string, log: (line: string) => void) {
  const app = new Hono<AuthVars>();
  const runner = deps.chain ? createClaimRunner(deps.db, deps.chain, log) : undefined;
  app.use("*", requireSession(deps, webOrigin));

  app.post("/onboarding/keys", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "payload_too_large" }, 413) }), async (c) => {
    const { user } = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const parsed = parseKeyBundle(body);
    if (!parsed.ok) return c.json({ error: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) }, 400);
    // The server recomputes keyId from the public key so a client cannot store a mismatching id.
    await ready();
    if (computeKeyId(parsed.keys.publicKey) !== parsed.keys.keyId) return c.json({ error: "invalid_field", field: "keyId" }, 400);
    const row = await insertUserKeys(deps.db, user.id, parsed.keys);
    if (!row) return c.json({ error: "keys_exist" }, 409);
    return c.json({ ok: true, onboardingState: "keys_created" }, 201);
  });

  app.get("/onboarding/keys", async (c) => {
    const { user } = c.get("auth");
    const k = await getUserKeys(deps.db, user.id);
    if (!k) return c.json({ error: "no_keys" }, 404);
    c.header("Cache-Control", "no-store");
    const e = (b: Buffer) => b.toString("base64");
    return c.json({
      publicKey: e(k.publicKey),
      keyId: k.keyId,
      walletSalt: e(k.walletSalt),
      recoverySalt: e(k.recoverySalt),
      wrappedPrivateKeyWallet: e(k.wrappedPrivateKeyWallet),
      wrappedPrivateKeyRecovery: e(k.wrappedPrivateKeyRecovery),
      wrappedSeedWallet: e(k.wrappedSeedWallet),
      wrappedSeedRecovery: e(k.wrappedSeedRecovery),
      passphraseMode: k.passphraseMode,
      keyVersion: k.keyVersion,
    });
  });

  app.get("/onboarding/username/:name/available", async (c) => {
    const { user } = c.get("auth");
    const name = c.req.param("name").toLowerCase();
    const fmt = checkUsernameFormat(name);
    if (!fmt.ok) return c.json({ username: name, available: false, reason: fmt.reason });
    if (await isUsernameTaken(deps.db, name, user.id)) return c.json({ username: name, available: false, reason: "taken" });
    if (!deps.chain) return c.json({ error: "chain_unavailable" }, 503);
    try {
      const s = await deps.chain.lookup(name);
      if (s.status === "available" || (s.status === "registered" && s.owner === user.walletAddress)) {
        return c.json({ username: name, available: true });
      }
      return c.json({ username: name, available: false, reason: s.status === "reserved" ? "reserved" : "taken" });
    } catch {
      return c.json({ error: "chain_unavailable" }, 502);
    }
  });

  app.post("/onboarding/username", bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "payload_too_large" }, 413) }), async (c) => {
    const { user } = c.get("auth");
    if (user.onboardingState === "name_claimed" || user.onboardingState === "done") return c.json({ error: "already_claimed" }, 409);
    if (user.onboardingState !== "keys_created") return c.json({ error: "keys_required" }, 409);
    if (!deps.chain || !deps.chain.canClaim || !runner) return c.json({ error: "operator_not_configured" }, 503);
    const body = (await c.req.json().catch(() => null)) as { username?: unknown } | null;
    const name = typeof body?.username === "string" ? body.username.toLowerCase() : "";
    const fmt = checkUsernameFormat(name);
    if (!fmt.ok) return c.json({ error: "invalid_username", reason: fmt.reason }, 400);

    const running = runner.get(user.id);
    if (running && (running.status === "queued" || running.status === "running")) {
      return running.username === name ? c.json(claimBody(running), 202) : c.json({ error: "claim_in_progress" }, 409);
    }
    if (await isUsernameTaken(deps.db, name, user.id)) return c.json({ error: "username_taken" }, 409);
    try {
      // A previously chosen name stays locked while it is registered to this wallet on chain.
      if (!isPendingUsername(user.username) && user.username !== name) {
        const old = await deps.chain.lookup(user.username);
        if (old.status === "registered" && old.owner === user.walletAddress) return c.json({ error: "username_locked", username: user.username }, 409);
      }
      const s = await deps.chain.lookup(name);
      if (s.status === "reserved" || (s.status === "registered" && s.owner !== user.walletAddress)) {
        return c.json({ error: "username_taken" }, 409);
      }
    } catch {
      return c.json({ error: "chain_unavailable" }, 502);
    }
    if ((await setUsername(deps.db, user.id, name)) === "taken") return c.json({ error: "username_taken" }, 409);
    return c.json(claimBody(runner.start(user.id, name, user.walletAddress)), 202);
  });

  app.get("/onboarding/status", async (c) => {
    const { user, hasKeys } = c.get("auth");
    c.header("Cache-Control", "no-store");
    const username = isPendingUsername(user.username) ? null : user.username;
    return c.json({
      onboardingState: user.onboardingState,
      hasKeys,
      username,
      ensName: user.ensName,
      canClaim: !!deps.chain?.canClaim,
      claim: claimBody(runner?.get(user.id), { username, state: user.onboardingState }),
    });
  });

  app.post("/onboarding/complete", async (c) => {
    const { user } = c.get("auth");
    if (user.onboardingState === "done") return c.json({ onboardingState: "done" });
    if (!(await markOnboardingDone(deps.db, user.id))) return c.json({ error: "wrong_state" }, 409);
    return c.json({ onboardingState: "done" });
  });

  return Object.assign(app, { runner });
}
