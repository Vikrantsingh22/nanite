/*
 * Custom domain onboarding routes (T3.6). Session auth + Origin check (inside requireSession); everything is scoped
 * to the session user (the domain is looked up by user id, never by a client-supplied id).
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireSession, type AuthVars } from "../auth/session.js";
import type { AuthDeps } from "../auth/types.js";
import { DomainApiError, type DomainService } from "../domains/service.js";
import { isResendRegion, type ResendRegion } from "../domains/resend-domains.js";

const MESSAGES: Record<string, string> = {
  invalid_domain: "That does not look like a valid domain name.",
  domain_reserved: "That domain belongs to Nanite and cannot be used. Use your own domain.",
  domain_taken: "That domain is already used by another account.",
  domain_exists: "You already added a mail domain. Remove it first to use another one.",
  domain_limit_reached: "Nanite's email provider has no free domain slot left. This is a limit on our side, not yours. Please contact support.",
  domain_verified: "A verified domain cannot be removed.",
  verify_rate_limited: "You can check again in a few seconds.",
  resend_not_configured: "Custom domains are not enabled on this server yet.",
  resend_unavailable: "The email provider did not answer. Try again in a moment.",
  no_domain: "You have not added a mail domain yet.",
};

export function domainRoutes(deps: AuthDeps, webOrigin: string, service: DomainService | undefined) {
  const app = new Hono<AuthVars>();
  const guard = requireSession(deps, webOrigin);
  app.use("/onboarding/domain", guard);
  app.use("/onboarding/domain/*", guard);

  const fail = (c: Context, e: unknown): Response => {
    if (e instanceof DomainApiError) {
      return c.json({ error: e.code, message: MESSAGES[e.code] ?? e.code, ...e.extra }, e.http as 400);
    }
    throw e;
  };
  const unavailable = (c: Context) => c.json({ error: "resend_not_configured", message: MESSAGES.resend_not_configured }, 503);
  const readBody = async (c: Context) => {
    const b = await c.req.json().catch(() => null);
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  };
  const limit = bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "payload_too_large" }, 413) });

  app.post("/onboarding/domain/check", limit, async (c) => {
    if (!service) return unavailable(c);
    const { user } = c.get("auth");
    const body = await readBody(c);
    try {
      c.header("Cache-Control", "no-store");
      return c.json(await service.check(user.id, body?.name));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/onboarding/domain", limit, async (c) => {
    if (!service) return unavailable(c);
    const { user } = c.get("auth");
    const body = await readBody(c);
    let region: ResendRegion | undefined;
    if (body?.region !== undefined) {
      if (!isResendRegion(body.region)) return c.json({ error: "invalid_region" }, 400);
      region = body.region;
    }
    try {
      const had = await service.get(user.id);
      const row = await service.create(user.id, body?.name, region);
      c.header("Cache-Control", "no-store");
      return c.json(service.view(row), had ? 200 : 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get("/onboarding/domain", async (c) => {
    if (!service) return unavailable(c);
    const { user } = c.get("auth");
    const row = await service.get(user.id);
    if (!row) return c.json({ error: "no_domain", message: MESSAGES.no_domain }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(service.view(row));
  });

  app.post("/onboarding/domain/verify", async (c) => {
    if (!service) return unavailable(c);
    const { user } = c.get("auth");
    try {
      const row = await service.verifyNow(user.id);
      c.header("Cache-Control", "no-store");
      return c.json(service.view(row));
    } catch (e) {
      if (e instanceof DomainApiError && e.http === 429) c.header("Retry-After", String(e.extra.retryAfterSeconds ?? 30));
      return fail(c, e);
    }
  });

  app.delete("/onboarding/domain", async (c) => {
    if (!service) return unavailable(c);
    const { user } = c.get("auth");
    try {
      await service.remove(user.id);
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  return app;
}
