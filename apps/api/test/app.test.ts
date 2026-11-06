import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "@nanite/db";
import { createApp, type AppDeps } from "../src/app.js";
import { loadEnv } from "../src/env.js";

const WEB_ORIGIN = "http://localhost:3000";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";

const handle = createDb(DATABASE_URL, { max: 1 });
afterAll(() => handle.close());

function make(overrides: Partial<AppDeps> = {}, logs: string[] = []) {
  return createApp({
    db: { ping: async () => void (await handle.client`select 1`) },
    webOrigin: WEB_ORIGIN,
    version: "9.9.9",
    log: (l) => logs.push(l),
    ...overrides,
  });
}

describe("health", () => {
  it("is ok with the real database", async () => {
    const res = await make().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "up", version: "9.9.9" });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("returns 503 when the database is down", async () => {
    const app = make({ db: { ping: async () => Promise.reject(new Error("boom")) } });
    const res = await app.request("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: "down", version: "9.9.9" });
  });

  it("GET / identifies the service", async () => {
    const res = await make().request("/");
    expect(await res.json()).toEqual({ service: "nanite-api" });
  });
});

describe("cors", () => {
  it("allows WEB_ORIGIN with credentials", async () => {
    const res = await make().request("/health", { headers: { Origin: WEB_ORIGIN } });
    expect(res.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("answers the preflight for WEB_ORIGIN", async () => {
    const res = await make().request("/health", {
      method: "OPTIONS",
      headers: { Origin: WEB_ORIGIN, "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
  });

  it("does not allow other origins", async () => {
    const evil = "http://evil.example";
    const res = await make().request("/health", { headers: { Origin: evil } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await make().request("/health", {
      method: "OPTIONS",
      headers: { Origin: evil, "Access-Control-Request-Method": "POST" },
    });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("sets secure headers", async () => {
    const res = await make().request("/");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("errors", () => {
  it("404 is JSON", async () => {
    const res = await make().request("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("500 is JSON and does not leak the error message", async () => {
    const app = make();
    app.get("/explode", () => {
      throw new Error("secret-detail-xyz");
    });
    const res = await app.request("/explode");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret-detail-xyz");
    expect(JSON.parse(text).error).toBe("internal_error");
  });
});

describe("logging", () => {
  it("never logs request bodies, query strings or the error message", async () => {
    const logs: string[] = [];
    const app = make({}, logs);
    app.post("/explode", () => {
      throw new Error("BODYMARKER-in-error");
    });
    const marker = "BODYMARKER-7f3a9";
    await app.request("/nope?q=QUERYMARKER", { method: "POST", body: JSON.stringify({ text: marker }) });
    await app.request("/explode", { method: "POST", body: marker });
    expect(logs.length).toBeGreaterThanOrEqual(3);
    const all = logs.join("\n");
    expect(all).not.toContain(marker);
    expect(all).not.toContain("QUERYMARKER");
    expect(all).not.toContain("BODYMARKER");
    const first = JSON.parse(logs[0]!);
    expect(first).toMatchObject({ method: "POST", path: "/nope", status: 404 });
    expect(typeof first.ms).toBe("number");
  });
});

describe("env", () => {
  it("applies defaults", () => {
    expect(loadEnv({ DATABASE_URL: "postgres://a/b" })).toEqual({
      port: 4000,
      databaseUrl: "postgres://a/b",
      webOrigin: "http://localhost:3000",
      devRoutes: false,
      authChainId: 11155111,
      dailyMailQuota: 90,
      resendDefaultRegion: "ap-northeast-1",
    });
  });

  it("parses DAILY_MAIL_QUOTA", () => {
    expect(loadEnv({ DATABASE_URL: "postgres://a/b", DAILY_MAIL_QUOTA: "25" }).dailyMailQuota).toBe(25);
    expect(() => loadEnv({ DATABASE_URL: "postgres://a/b", DAILY_MAIL_QUOTA: "lots" })).toThrow(/DAILY_MAIL_QUOTA/);
  });

  it("validates the Arkiv key without echoing it, and gates dev routes", () => {
    const bad = "0xnot-a-key-SECRETMARKER";
    expect(() => loadEnv({ DATABASE_URL: "postgres://a/b", ARKIV_OPERATOR_PRIVATE_KEY: bad })).toThrow(/ARKIV_OPERATOR_PRIVATE_KEY/);
    try {
      loadEnv({ DATABASE_URL: "postgres://a/b", ARKIV_OPERATOR_PRIVATE_KEY: bad });
    } catch (e) {
      expect(String(e)).not.toContain("SECRETMARKER");
    }
    const ok = loadEnv({ DATABASE_URL: "postgres://a/b", ARKIV_OPERATOR_PRIVATE_KEY: "0x" + "ab".repeat(32), DEV_ROUTES: "1" });
    expect(ok.arkivOperatorPrivateKey).toBe("0x" + "ab".repeat(32));
    expect(ok.devRoutes).toBe(true);
    expect(loadEnv({ DATABASE_URL: "postgres://a/b", DEV_ROUTES: "1", NODE_ENV: "production" }).devRoutes).toBe(false);
  });

  it("fails fast with a clear message", () => {
    expect(() => loadEnv({ PORT: "abc", WEB_ORIGIN: "nope" })).toThrow(/PORT[\s\S]*DATABASE_URL is required[\s\S]*WEB_ORIGIN/);
  });
});
