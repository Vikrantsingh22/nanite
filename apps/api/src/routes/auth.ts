import { randomBytes } from "node:crypto";
import {
  consumeAuthNonce,
  createAuthNonce,
  createSession,
  findSessionUser,
  getUserDomain,
  isPendingUsername,
  revokeSession,
  upsertUserByWallet,
} from "@nanite/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, setCookie } from "hono/cookie";
import { domainSummary, type DomainSummary } from "../domains/view.js";
import { checkSiwe } from "../auth/siwe.js";
import { readSessionId, requireSession, type AuthVars } from "../auth/session.js";
import { SESSION_COOKIE, type AuthDeps } from "../auth/types.js";

const NONCE_TTL_MS = 5 * 60_000;
const DEFAULT_SESSION_TTL_S = 7 * 24 * 3600;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;

type MeUser = { walletAddress: string; username: string; ensName: string | null; onboardingState: string };
export const meBody = (user: MeUser, hasKeys: boolean, domain: DomainSummary | null = null) => ({
  wallet: user.walletAddress,
  username: isPendingUsername(user.username) ? null : user.username,
  ensName: user.ensName,
  onboardingState: user.onboardingState,
  hasKeys,
  domain,
});

export function authRoutes(deps: AuthDeps, webOrigin: string) {
  const app = new Hono<AuthVars>();
  const domain = new URL(webOrigin).host;
  const ttl = deps.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_S;

  app.get("/auth/nonce", async (c) => {
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
    await createAuthNonce(deps.db, nonce, expiresAt);
    c.header("Cache-Control", "no-store");
    return c.json({ nonce, expiresAt: expiresAt.toISOString() });
  });

  app.post("/auth/verify", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "payload_too_large" }, 413) }), async (c) => {
    const origin = c.req.header("origin");
    if (origin && origin !== webOrigin) return c.json({ error: "bad_origin" }, 403);
    const body = (await c.req.json().catch(() => null)) as { message?: unknown; signature?: unknown } | null;
    const message = body?.message;
    const signature = body?.signature;
    if (typeof message !== "string" || message.length > 2000 || typeof signature !== "string" || !SIG_RE.test(signature)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const res = await checkSiwe(message, signature, { domain, origin: webOrigin, chainIds: deps.chainIds });
    if (!res.ok) return c.json({ error: "invalid_siwe", reason: res.reason }, 401);
    if (!(await consumeAuthNonce(deps.db, res.nonce, res.address))) {
      return c.json({ error: "invalid_siwe", reason: "nonce" }, 401);
    }
    const user = await upsertUserByWallet(deps.db, res.address);
    const session = await createSession(deps.db, user.id, new Date(Date.now() + ttl * 1000));
    setCookie(c, SESSION_COOKIE, session.id, {
      httpOnly: true,
      secure: deps.secureCookie,
      sameSite: "Lax",
      path: "/",
      maxAge: ttl,
    });
    c.header("Cache-Control", "no-store");
    const found = await findSessionUser(deps.db, session.id);
    return c.json(meBody(user, found?.hasKeys ?? false, domainSummary(await getUserDomain(deps.db, user.id))));
  });

  app.post("/auth/logout", async (c) => {
    const origin = c.req.header("origin");
    if (origin && origin !== webOrigin) return c.json({ error: "bad_origin" }, 403);
    const id = readSessionId(c);
    if (id) await revokeSession(deps.db, id);
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: deps.secureCookie });
    return c.json({ ok: true });
  });

  app.get("/me", requireSession(deps, webOrigin), async (c) => {
    const { user, hasKeys } = c.get("auth");
    c.header("Cache-Control", "no-store");
    return c.json(meBody(user, hasKeys, domainSummary(await getUserDomain(deps.db, user.id))));
  });

  return app;
}
