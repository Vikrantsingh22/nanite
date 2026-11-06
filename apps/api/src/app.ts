import { Hono, type Context } from "hono";
import { createRateLimiter, type RateLimiter } from "./agent-api/rate-limit.js";
import { clientIp } from "./net/client-ip.js";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { InboundDeps } from "./inbound/pipeline.js";
import type { AuthDeps } from "./auth/types.js";
import { agentRoutes, type AgentsConfig } from "./routes/agents.js";
import { authRoutes } from "./routes/auth.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { domainRoutes } from "./routes/domains.js";
import type { DomainService } from "./domains/service.js";
import { devOutboxRoutes, devRoutes, type DevInbox, type DevOutbox } from "./routes/dev.js";
import { healthRoutes } from "./routes/health.js";
import { mailRoutes, type MailDeps } from "./routes/mail.js";
import { v1Routes, type V1Deps } from "./routes/v1.js";
import { webhookRoutes } from "./routes/webhooks.js";

export interface AppDeps {
  /** Database liveness probe. Rejects when the database is unreachable. */
  db: { ping: () => Promise<void> };
  /** The only browser origin allowed by CORS. */
  webOrigin: string;
  version: string;
  /** Log sink (one line per call). Defaults to console.log. */
  log?: (line: string) => void;
  /** Inbound mail pipeline. When absent, POST /webhooks/resend answers 503. */
  inbound?: InboundDeps;
  /** DEV ONLY: when set, mounts GET /internal/dev/inbox/:agentEns (metadata only). Never set in production. */
  devInbox?: DevInbox;
  /** DEV ONLY (FAKE_RESEND_SEND=1 + DEV_ROUTES=1): mounts GET /internal/dev/outbox (From + headers of fake sends). */
  devOutbox?: DevOutbox;
  /** Agent API (/v1/*). When absent the routes are not mounted. */
  v1?: V1Deps;
  /** Browser sign-in (SIWE), sessions and onboarding. When absent the routes are not mounted. */
  auth?: AuthDeps;
  /** Dashboard agent management (/agents/*, needs `auth`): ENS chain port, master key, mail domain. */
  agents?: AgentsConfig;
  /** Encrypted mail proxy for the browser (/mail/*, session auth). Needs `auth`. */
  mail?: MailDeps;
  /** Custom domain onboarding (/onboarding/domain*, Resend domain.* webhook events). When absent the routes answer 503. */
  domains?: DomainService;
  /** TRUST_PROXY=1: take the client IP from the proxy's X-Forwarded-For (see net/client-ip.ts). Default false. */
  trustProxy?: boolean;
  /** Per-IP limiter for /auth/nonce and /auth/verify (default 60 per minute). */
  authLimiter?: RateLimiter;
}

type AppEnv = { Variables: { requestId: string } };

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

export function createApp(deps: AppDeps) {
  const log = deps.log ?? ((line: string) => console.log(line));
  const app = new Hono<AppEnv>();

  // Request id: reuse a sane inbound x-request-id, otherwise generate one.
  app.use("*", async (c, next) => {
    const inbound = c.req.header("x-request-id");
    const id = inbound && REQUEST_ID_RE.test(inbound) ? inbound : crypto.randomUUID();
    c.set("requestId", id);
    c.header("x-request-id", id);
    await next();
  });

  // Access log: method, path (no query string), status, duration. Never headers or bodies.
  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    log(
      JSON.stringify({
        level: "info",
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - start),
      }),
    );
  });

  app.use("*", secureHeaders());

  app.use(
    "*",
    cors({
      origin: (origin) => (origin === deps.webOrigin ? origin : null),
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
      exposeHeaders: ["X-Request-Id"],
      maxAge: 600,
    }),
  );

  // Sign-in endpoints are unauthenticated: cap them per client IP (behind Caddy only with TRUST_PROXY=1).
  const authLimiter = deps.authLimiter ?? createRateLimiter({ limit: 60, windowMs: 60_000 });
  const trustProxy = deps.trustProxy ?? false;
  app.use("/auth/nonce", async (c, next) => limitByIp(c, next));
  app.use("/auth/verify", async (c, next) => limitByIp(c, next));
  async function limitByIp(c: Context, next: () => Promise<void>) {
    if (c.req.method === "OPTIONS") return next();
    const rl = authLimiter.hit(clientIp(c, trustProxy));
    if (!rl.allowed) {
      c.header("Retry-After", String(rl.retryAfterSec));
      return c.json({ error: "rate_limited" }, 429);
    }
    return next();
  }

  app.get("/", (c) => c.json({ service: "nanite-api" }));
  app.route("/", healthRoutes(deps));
  app.route("/", webhookRoutes(deps, log));
  if (deps.devInbox) app.route("/", devRoutes(deps.devInbox));
  if (deps.devOutbox) app.route("/", devOutboxRoutes(deps.devOutbox));
  if (deps.v1) app.route("/", v1Routes(deps.v1));
  if (deps.auth) {
    app.route("/", authRoutes(deps.auth, deps.webOrigin));
    app.route("/", domainRoutes(deps.auth, deps.webOrigin, deps.domains));
    app.route("/", onboardingRoutes(deps.auth, deps.webOrigin, log, deps.agents?.sharedMailDomain));
    app.route("/", agentRoutes(deps.auth, deps.webOrigin, log, deps.agents));
    if (deps.mail) app.route("/", mailRoutes(deps.auth, deps.webOrigin, deps.mail));
  }

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  // Never echo the request or the error message (it may contain request content).
  app.onError((err, c) => {
    log(
      JSON.stringify({
        level: "error",
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        error: err.name,
      }),
    );
    return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
