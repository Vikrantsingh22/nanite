import { Hono } from "hono";
import type { AppDeps } from "../app.js";

export function healthRoutes(deps: Pick<AppDeps, "db" | "version">) {
  const app = new Hono();

  app.get("/health", async (c) => {
    let db: "up" | "down" = "down";
    try {
      await deps.db.ping();
      db = "up";
    } catch {
      db = "down";
    }
    return c.json({ ok: db === "up", db, version: deps.version }, db === "up" ? 200 : 503);
  });

  return app;
}
