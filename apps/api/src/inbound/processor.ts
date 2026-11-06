/*
 * Background processing of accepted inbound events (see pipeline.ts, phase 2).
 *
 * - enqueue(): events run strictly one after another (single flight, on top of the Arkiv writer's own queue).
 * - sweep(): re-processes events a crash or a transient failure left behind: `received` (accepted, never claimed),
 *   `processing` (claimed by a process that died) and `failed` (retryable), with a bounded number of attempts.
 *   Resend only retries webhooks that were NOT answered 200, so after the early 200 this sweep is the retry.
 * - startSweeper(): sweep once at startup (nothing can be in flight in a fresh process, so nothing is "too young"),
 *   then every minute.
 *
 * The claim in processInboundEventById is atomic, so queueing the same event twice (route + sweep) writes once.
 */
import { and, asc, eq, inArray, isNotNull, like, lt, or, sql } from "drizzle-orm";
import { webhookEvents } from "@nanite/db";
import { processInboundEventById, STALE_PROCESSING_MS, type InboundDeps } from "./pipeline.js";

export const MAX_EVENT_ATTEMPTS = 5;
/** A `received` event younger than this is probably still in the in-memory queue. */
const RECEIVED_GRACE_MS = 30_000;
/** Minimum wait before a failed event is tried again by the periodic sweep. */
const RETRY_DELAY_MS = 60_000;
const SWEEP_BATCH = 50;

export interface InboundProcessor {
  /** Queue an accepted event (webhook_events.id) for background processing. Returns immediately. */
  enqueue(eventRowId: string, opts?: { force?: boolean }): void;
  /** Resolves when the queue is empty (tests, graceful shutdown). */
  idle(): Promise<void>;
  /** Queue every event that needs another run. `startup: true` ignores the age thresholds. Returns how many were queued. */
  sweep(opts?: { startup?: boolean; /** Only events whose provider event id starts with this (tests). */ eventIdPrefix?: string }): Promise<number>;
  /** Sweep now (startup mode) and then every `intervalMs`. Returns a stop function. */
  startSweeper(intervalMs?: number): () => void;
}

export function createInboundProcessor(deps: InboundDeps, log: (fields: Record<string, unknown>) => void): InboundProcessor {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  const queued = new Set<string>();

  const processor: InboundProcessor = {
    enqueue(eventRowId, opts = {}) {
      if (queued.has(eventRowId)) return;
      queued.add(eventRowId);
      pending += 1;
      tail = tail
        .then(async () => {
          try {
            await processInboundEventById(deps, eventRowId, log, opts);
          } catch {
            /* a database error: the row stays received/processing and the sweep picks it up */
            log({ event: "inbound", outcome: "background_error" });
          } finally {
            queued.delete(eventRowId);
            pending -= 1;
          }
        });
    },

    async idle() {
      while (pending > 0) await tail;
    },

    async sweep(opts = {}) {
      const { db } = deps;
      const now = (deps.now?.() ?? new Date()).getTime();
      const startup = opts.startup === true;
      const before = (ms: number) => new Date(now - (startup ? 0 : ms));

      // Events that used up their attempts are parked as failed (visible in the table, not retried).
      await db
        .update(webhookEvents)
        .set({ status: "failed", error: "attempts_exhausted" })
        .where(
          and(
            eq(webhookEvents.status, "processing"),
            sql`${webhookEvents.attempts} >= ${MAX_EVENT_ATTEMPTS}`,
            lt(webhookEvents.updatedAt, before(STALE_PROCESSING_MS)),
            opts.eventIdPrefix ? like(webhookEvents.providerEventId, `${opts.eventIdPrefix}%`) : undefined,
          ),
        );

      const rows = await db
        .select({ id: webhookEvents.id, status: webhookEvents.status })
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.provider, "resend"),
            isNotNull(webhookEvents.resendEmailId),
            opts.eventIdPrefix ? like(webhookEvents.providerEventId, `${opts.eventIdPrefix}%`) : undefined,
            sql`${webhookEvents.attempts} < ${MAX_EVENT_ATTEMPTS}`,
            or(
              and(eq(webhookEvents.status, "received"), lt(webhookEvents.updatedAt, before(RECEIVED_GRACE_MS))),
              and(eq(webhookEvents.status, "failed"), lt(webhookEvents.updatedAt, before(RETRY_DELAY_MS))),
              and(inArray(webhookEvents.status, ["processing"]), lt(webhookEvents.updatedAt, before(STALE_PROCESSING_MS))),
            ),
          ),
        )
        .orderBy(asc(webhookEvents.createdAt))
        .limit(SWEEP_BATCH);

      let n = 0;
      for (const r of rows) {
        if (queued.has(r.id)) continue;
        processor.enqueue(r.id, startup && r.status === "processing" ? { force: true } : {});
        n += 1;
      }
      if (n > 0) log({ event: "inbound", outcome: "sweep", queued: n });
      return n;
    },

    startSweeper(intervalMs = 60_000) {
      const run = (startup: boolean) => void processor.sweep({ startup }).catch(() => log({ event: "inbound", outcome: "sweep_error" }));
      run(true);
      const timer = setInterval(() => run(false), intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
  return processor;
}
