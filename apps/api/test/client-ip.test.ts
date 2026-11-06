import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/agent-api/rate-limit.js";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { clientIp, trustProxyFromEnv } from "../src/net/client-ip.js";

function probe(trust: boolean) {
  const app = new Hono();
  app.get("/ip", (c) => c.text(clientIp(c, trust, "10.0.0.9")));
  return app;
}
const get = async (app: Hono, xff?: string) => (await app.request("/ip", { headers: xff ? { "x-forwarded-for": xff } : {} })).text();

describe("client IP behind a proxy", () => {
  it("ignores X-Forwarded-For unless TRUST_PROXY=1", async () => {
    expect(await get(probe(false), "1.2.3.4")).toBe("10.0.0.9");
    expect(trustProxyFromEnv({})).toBe(false);
    expect(trustProxyFromEnv({ TRUST_PROXY: "0" })).toBe(false);
    expect(trustProxyFromEnv({ TRUST_PROXY: "true" })).toBe(false);
    expect(trustProxyFromEnv({ TRUST_PROXY: "1" })).toBe(true);
  });

  it("with the proxy trusted, uses the rightmost entry (what Caddy saw), never a client-forged first entry", async () => {
    const app = probe(true);
    expect(await get(app, "203.0.113.7")).toBe("203.0.113.7");
    expect(await get(app, "6.6.6.6, 203.0.113.7")).toBe("203.0.113.7");
    expect(await get(app, "2001:db8::1")).toBe("2001:db8::1");
  });

  it("falls back to the socket address for a missing or malformed header", async () => {
    const app = probe(true);
    expect(await get(app)).toBe("10.0.0.9");
    expect(await get(app, "not an ip!")).toBe("10.0.0.9");
  });

  it("rate limits /auth/nonce and /auth/verify per client IP, not across IPs", async () => {
    const mk = (trustProxy: boolean) =>
      createApp({ db: { ping: async () => undefined }, webOrigin: "http://localhost:3000", version: "t", log: () => undefined, trustProxy, authLimiter: createRateLimiter({ limit: 2 }) });
    const app = mk(true);
    const hit = async (ip: string, path = "/auth/nonce") => (await app.request(path, { headers: { "x-forwarded-for": ip } })).status;
    expect(await hit("198.51.100.1")).not.toBe(429);
    expect(await hit("198.51.100.1", "/auth/verify")).not.toBe(429);
    expect(await hit("198.51.100.1")).toBe(429);
    expect(await hit("198.51.100.2")).not.toBe(429);
    // forging extra leading entries does not give a fresh bucket
    expect(await hit("9.9.9.9, 198.51.100.1")).toBe(429);
    // /health is never limited
    expect((await mk(true).request("/health")).status).not.toBe(429);
  });
});

describe("production safety of the environment", () => {
  const base = { DATABASE_URL: "postgres://u:p@db:5432/n", WEB_ORIGIN: "https://nanite.itsvikrant.tech" };
  it("DEV_ROUTES is ignored when NODE_ENV=production", () => {
    expect(loadEnv({ ...base, DEV_ROUTES: "1" }).devRoutes).toBe(true);
    expect(loadEnv({ ...base, DEV_ROUTES: "1", NODE_ENV: "production" }).devRoutes).toBe(false);
  });
  it("CORS allows exactly WEB_ORIGIN with credentials", async () => {
    const app = createApp({ db: { ping: async () => undefined }, webOrigin: "https://nanite.itsvikrant.tech", version: "t", log: () => undefined });
    const ok = await app.request("/health", { headers: { origin: "https://nanite.itsvikrant.tech" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://nanite.itsvikrant.tech");
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    for (const o of ["https://evil.example", "https://nanite.itsvikrant.tech.evil.example", "http://nanite.itsvikrant.tech"]) {
      const bad = await app.request("/health", { headers: { origin: o } });
      expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});
