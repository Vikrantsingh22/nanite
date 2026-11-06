import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppDeps } from "../app.js";
import { acceptInboundEvent, handleInboundEvent } from "../inbound/pipeline.js";
import { createInboundProcessor } from "../inbound/processor.js";

/** Resend webhook payloads are metadata only; anything big is not from Resend. */
const MAX_BODY_BYTES = 512 * 1024;

/*
 * Flow: verify signature -> durably record + route the event (DB only) -> answer 200 -> fetch, encrypt and write to
 * Arkiv in the background (inbound/processor.ts). The Arkiv write takes seconds and Resend's webhook timeout is not
 * documented, so the request never waits for it. WEBHOOK_SYNC=1 (dev/test, ignored in production) restores the old
 * "wait for the whole pipeline" behaviour, which the live scripts rely on to read `{"status":"stored"}`.
 */
export function webhookRoutes(deps: Pick<AppDeps, "inbound" | "domains">, log: (line: string) => void) {
  const app = new Hono<{ Variables: { requestId: string } }>();
  const processor =
    deps.inbound && !deps.inbound.sync
      ? (deps.inbound.processor ?? createInboundProcessor(deps.inbound, (fields) => log(JSON.stringify({ level: fields.outcome === "failed" ? "error" : "info", ...fields }))))
      : undefined;

  app.post(
    "/webhooks/resend",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "payload_too_large" }, 413) }),
    async (c) => {
      const inbound = deps.inbound;
      if (!inbound) return c.json({ error: "webhook_not_configured" }, 503);

      // Raw bytes, exactly as sent: the signature covers them.
      const raw = new Uint8Array(await c.req.arrayBuffer());
      let event;
      try {
        event = inbound.provider.verifyWebhook(raw, c.req.raw.headers);
      } catch {
        return c.json({ error: "unauthorized" }, 401);
      }

      const requestId = c.get("requestId");
      const logFields = (fields: Record<string, unknown>) =>
        log(JSON.stringify({ level: fields.outcome === "failed" ? "error" : "info", requestId, ...fields }));

      // Domain lifecycle events (custom domain onboarding). Never touches the email pipeline.
      if (event.kind === "domain") {
        if (!deps.domains) return c.json({ status: "ignored" }, 200);
        try {
          const outcome = await deps.domains.applyWebhook({ type: event.type, domainId: event.domainId, status: event.status, records: event.records });
          return c.json({ status: outcome }, 200);
        } catch {
          // Not acknowledged: Resend retries the event.
          return c.json({ error: "processing_failed", requestId }, 500);
        }
      }

      if (!processor) {
        const result = await handleInboundEvent(inbound, event, logFields);
        if (result.http === 500) return c.json({ error: "processing_failed", requestId }, 500);
        return c.json({ status: result.status }, 200);
      }

      if (event.kind === "ignored") return c.json({ status: "ignored" }, 200);
      let accepted;
      try {
        accepted = await acceptInboundEvent(inbound, event, logFields);
      } catch {
        // The event could not be recorded: not acknowledged, so the provider retries it.
        return c.json({ error: "processing_failed", requestId }, 500);
      }
      if (accepted.status === "accepted") {
        processor.enqueue(accepted.eventRowId);
        return c.json({ status: "accepted" }, 200);
      }
      return c.json({ status: accepted.status }, 200);
    },
  );

  return app;
}
