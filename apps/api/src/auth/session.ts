import { findSessionUser } from "@nanite/db";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE, type AuthDeps } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SessionUser = NonNullable<Awaited<ReturnType<typeof findSessionUser>>>;
export type AuthVars = { Variables: { requestId: string; auth: SessionUser } };

export function readSessionId(c: Context): string | null {
  const id = getCookie(c, SESSION_COOKIE);
  return id && UUID_RE.test(id) ? id : null;
}

/** Loads the session, answers 401 otherwise. State-changing requests must carry the allowed Origin (CSRF defence in depth on top of SameSite=Lax). */
export function requireSession(deps: AuthDeps, webOrigin: string): MiddlewareHandler<AuthVars> {
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin && origin !== webOrigin) return c.json({ error: "bad_origin" }, 403);
    }
    const id = readSessionId(c);
    const found = id ? await findSessionUser(deps.db, id) : null;
    if (!found) return c.json({ error: "unauthenticated" }, 401);
    c.set("auth", found);
    await next();
  };
}
