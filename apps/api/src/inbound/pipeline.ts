/*
 * Inbound pipeline: verified Resend event -> routing -> fetch -> classify -> encrypt -> Arkiv writer.
 *
 * Two phases, so the webhook can answer fast (an Arkiv write takes several seconds):
 *   1. acceptInboundEvent (DB only, milliseconds): durably record the event (webhook_events, unique per provider
 *      event id), route the recipients to active mailboxes and queue one `arkiv_writes` ledger row per mailbox
 *      (status `queued`). Nothing is lost if the process dies after this point: the routing is in Postgres.
 *   2. processInboundEventById (slow): claim the event, fetch the content, encrypt, write to Arkiv, mark `stored`.
 *      Run in the background by ./processor.ts (single-flight, startup/periodic sweep); handleInboundEvent runs
 *      both phases inline (used by tests, scripts and WEBHOOK_SYNC=1).
 *
 * Privacy rules (enforced by tests): subject, body, sender address and OTP codes never reach logs or
 * Postgres. Postgres gets only ids, statuses, entity keys / tx hashes and fixed error codes (the
 * `arkiv_writes` ledger has no ciphertext column).
 *
 * Structured agent fields {otp?, links, from?, messageId?, references?} travel in `PlainEmail.meta` inside the encrypted payload
 * (`rawEml` stays reserved for the real raw .eml). Encrypted to the same recipients as subject/body.
 *
 * Only the TEXT part is stored (or the HTML stripped to text), capped at 64 KiB with a marker; the HTML is never stored.
 *
 * Per-recipient idempotency: one `arkiv_writes` row per (webhook event, mailbox). A `confirmed` row is never
 * written again on a retry; its entity key is reused. The webhook event is `stored` only when every routed
 * recipient is confirmed.
 */
import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { encryptEmail, senderHash, type Recipient } from "@nanite/crypto";
import {
  agents,
  arkivWrites,
  countMailSince,
  findMailboxByAddress,
  findMailboxById,
  utcDayStart,
  recordWebhookEvent,
  userKeys,
  webhookEvents,
  type Db,
} from "@nanite/db";
import type { ArkivWriterPort } from "../arkiv/port.js";
import type { InboundEvent, MailProvider } from "../mail/provider.js";
import { ProviderError } from "../mail/resend.js";
import type { InboundProcessor } from "./processor.js";
import { bodyText, capBody, capSubject, classify, extractLinks, parseFromAddress, threadId, threadingMeta } from "./classify.js";

export interface InboundDeps {
  db: Db;
  provider: MailProvider;
  arkiv: ArkivWriterPort;
  /** SENDER_HASH_SECRET (also keys the opaque threadId). */
  senderHashSecret: string;
  /** DAILY_MAIL_QUOTA: only used to log a warning (counts) when exceeded; inbound is always stored. */
  dailyMailQuota?: number | undefined;
  now?: () => Date;
  /** Background processor used by POST /webhooks/resend (the route creates one when absent). */
  processor?: InboundProcessor | undefined;
  /** Dev/test only (WEBHOOK_SYNC=1): the webhook request waits for the whole pipeline, like before the async split. */
  sync?: boolean | undefined;
}

export type InboundResult =
  | { http: 200; status: "stored" | "dropped" | "duplicate" | "ignored" }
  | { http: 500; status: "failed" };

export type AcceptResult = { status: "accepted"; eventRowId: string } | { status: "dropped" | "duplicate" };

/** Fixed error codes are the only error text that is stored or logged. */
export class PipelineError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PipelineError";
  }
}

/** A `processing` row older than this is considered abandoned (crash) and may be retried. */
export const STALE_PROCESSING_MS = 5 * 60 * 1000;
/** `webhook_events.error` of an event dropped because the API key is wrong/restricted: a replay may reprocess it. */
export const PROVIDER_CONFIG_ERROR = "provider_config_error";

type Log = (fields: Record<string, unknown>) => void;

/** Phase 1 + 2 inline. Same contract as before the async split. */
export async function handleInboundEvent(deps: InboundDeps, event: InboundEvent, log: Log): Promise<InboundResult> {
  if (event.kind === "ignored" || event.kind === "domain") return { http: 200, status: "ignored" };
  const accepted = await acceptInboundEvent(deps, event, log);
  if (accepted.status !== "accepted") return { http: 200, status: accepted.status };
  return processInboundEventById(deps, accepted.eventRowId, log);
}

/**
 * Phase 1: durable record + routing + queued ledger rows. DB only (no provider or Arkiv call), so it is fast.
 * Throws only on a database failure (the route then answers 500 and the provider retries the webhook).
 */
export async function acceptInboundEvent(
  deps: InboundDeps,
  event: Extract<InboundEvent, { kind: "received" }>,
  log: Log,
): Promise<AcceptResult> {
  const { db } = deps;
  const { event: row } = await recordWebhookEvent(db, {
    provider: "resend",
    providerEventId: event.providerEventId,
    resendEmailId: event.emailId,
  });
  const staleBefore = new Date((deps.now?.() ?? new Date()).getTime() - STALE_PROCESSING_MS);
  const reclaimable =
    row.status === "received" ||
    row.status === "failed" ||
    (row.status === "processing" && row.updatedAt < staleBefore) ||
    (row.status === "dropped" && row.error === PROVIDER_CONFIG_ERROR);
  if (!reclaimable) return { status: "duplicate" };

  // Route BEFORE touching any content. Unknown / disabled / revoked recipients are dropped.
  const mailboxIds: string[] = [];
  for (const address of event.recipients) {
    const m = await findMailboxByAddress(db, address);
    if (m && m.mailboxStatus === "active" && m.agentRevokedAt === null && !mailboxIds.includes(m.mailboxId)) mailboxIds.push(m.mailboxId);
  }
  if (mailboxIds.length === 0) {
    const done = await db
      .update(webhookEvents)
      .set({ status: "dropped", arkivEntityKey: null, error: "no_active_mailbox" })
      .where(and(eq(webhookEvents.id, row.id), eq(webhookEvents.status, row.status)))
      .returning({ id: webhookEvents.id });
    if (done.length === 0) return { status: "duplicate" };
    log({ event: "inbound", outcome: "dropped", eventId: event.providerEventId });
    return { status: "dropped" };
  }

  if (row.status === "dropped") {
    const back = await db
      .update(webhookEvents)
      .set({ status: "received", error: null })
      .where(and(eq(webhookEvents.id, row.id), eq(webhookEvents.status, "dropped")))
      .returning({ id: webhookEvents.id });
    if (back.length === 0) return { status: "duplicate" };
  }
  // One at a time, in order: the ledger order is the processing order.
  for (const mailboxId of mailboxIds) {
    await db
      .insert(arkivWrites)
      .values({ kind: "email", status: "queued", webhookEventId: row.id, mailboxId, attempts: 0 })
      .onConflictDoNothing({ target: [arkivWrites.webhookEventId, arkivWrites.mailboxId] });
  }
  return { status: "accepted", eventRowId: row.id };
}

/**
 * Phase 2: claim the stored event and run fetch -> encrypt -> Arkiv. `force` also claims a `processing` row that is
 * not stale yet (only the startup sweep uses it: no work can be in flight in a freshly started process).
 */
export async function processInboundEventById(
  deps: InboundDeps,
  eventRowId: string,
  log: Log,
  opts: { force?: boolean } = {},
): Promise<InboundResult> {
  const { db } = deps;
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, eventRowId)).limit(1);
  if (!row || !row.resendEmailId) return { http: 200, status: "duplicate" };
  const emailId = row.resendEmailId;
  const eventId = row.providerEventId;

  // Atomic claim: only a fresh, failed or abandoned event may be (re)processed. Everything else is a duplicate.
  const staleBefore = new Date((deps.now?.() ?? new Date()).getTime() - STALE_PROCESSING_MS);
  const claimed = await db
    .update(webhookEvents)
    .set({ status: "processing", attempts: sql`${webhookEvents.attempts} + 1`, error: null })
    .where(
      and(
        eq(webhookEvents.id, row.id),
        or(
          eq(webhookEvents.status, "received"),
          eq(webhookEvents.status, "failed"),
          and(eq(webhookEvents.status, "processing"), opts.force ? undefined : lt(webhookEvents.updatedAt, staleBefore)),
        ),
      ),
    )
    .returning({ id: webhookEvents.id });
  if (claimed.length === 0) return { http: 200, status: "duplicate" };

  // Mail quota: inbound is NEVER refused, only noticed (counts only; sends are what the quota blocks).
  if (deps.dailyMailQuota !== undefined) {
    try {
      const c = await countMailSince(db, utcDayStart(deps.now?.() ?? new Date()));
      if (c.sent + c.received > deps.dailyMailQuota) {
        log({ event: "quota_exceeded", sent: c.sent, received: c.received, quota: deps.dailyMailQuota });
      }
    } catch {
      /* the warning is best-effort */
    }
  }

  const finish = (status: "stored" | "dropped" | "failed", extra: { entityKey?: string; error?: string } = {}) =>
    db
      .update(webhookEvents)
      .set({ status, arkivEntityKey: extra.entityKey ?? null, error: extra.error ?? null })
      .where(eq(webhookEvents.id, row.id));

  try {
    // 1. The routing stored by acceptInboundEvent, re-checked now (a mailbox may have been disabled since).
    const ledger = await db
      .select({ mailboxId: arkivWrites.mailboxId, entityKey: arkivWrites.entityKey, status: arkivWrites.status })
      .from(arkivWrites)
      .where(eq(arkivWrites.webhookEventId, row.id))
      .orderBy(asc(arkivWrites.createdAt));
    const routes = new Map<string, NonNullable<Awaited<ReturnType<typeof findMailboxById>>>>();
    for (const l of ledger) {
      if (!l.mailboxId) continue;
      const m = await findMailboxById(db, l.mailboxId);
      if (m && m.mailboxStatus === "active" && m.agentRevokedAt === null) routes.set(m.mailboxId, m);
    }
    if (routes.size === 0) {
      await finish("dropped", { error: "no_active_mailbox" });
      log({ event: "inbound", outcome: "dropped", eventId });
      return { http: 200, status: "dropped" };
    }

    // 2. Which recipients are already confirmed (an earlier attempt)? They are never written again.
    const confirmed = new Map<string, string>(); // mailboxId -> entityKey
    for (const l of ledger) if (l.status === "confirmed" && l.mailboxId && l.entityKey && routes.has(l.mailboxId)) confirmed.set(l.mailboxId, l.entityKey);
    const pending = [...routes.values()].filter((r) => !confirmed.has(r.mailboxId));

    let type: string | undefined;
    const failures: string[] = [];

    if (pending.length > 0) {
      // 3. Full content (untrusted). Only now, and only if something still has to be written.
      let mail;
      try {
        mail = await deps.provider.fetchReceived(emailId);
      } catch (err) {
        const terminal = terminalFetchFailure(err);
        if (!terminal) throw err;
        await finish("dropped", { error: terminal.error });
        log({
          event: "inbound",
          outcome: "dropped",
          eventId,
          code: terminal.error,
          ...(terminal.providerError ? { providerError: terminal.providerError } : {}),
          ...(terminal.config ? { level: "error", note: "provider configuration problem (API key)" } : {}),
          ...(terminal.counts ? await quotaCounts(deps) : {}),
        });
        return { http: 200, status: "dropped" };
      }
      const fullText = bodyText(mail);
      const links = extractLinks(fullText, mail.html);
      const { text: body } = capBody(fullText); // the text only, never the HTML; long mail is cut with a marker
      const subject = capSubject(mail.subject);
      const cls = classify(subject, body);
      type = cls.type;
      const receivedAt = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
      // Sender address, Message-ID and References go ONLY inside the encrypted payload.
      const fromAddr = parseFromAddress(mail.from);
      const threadMeta = threadingMeta(mail);

      for (const route of pending) {
        try {
          const [uk] = await db.select({ publicKey: userKeys.publicKey, keyId: userKeys.keyId }).from(userKeys).where(eq(userKeys.userId, route.userId)).limit(1);
          const [ag] = await db.select({ publicKey: agents.publicKey, keyId: agents.keyId }).from(agents).where(eq(agents.id, route.agentId)).limit(1);
          if (!uk) throw new PipelineError("no_user_key");
          if (!ag) throw new PipelineError("no_agent_key");
          const recipients: Recipient[] = [
            { keyId: uk.keyId, publicKey: new Uint8Array(uk.publicKey) },
            { keyId: ag.keyId, publicKey: new Uint8Array(ag.publicKey) },
          ];
          let enc;
          try {
            enc = await encryptEmail(
              { subject, body, meta: { ...(cls.otp ? { otp: cls.otp } : {}), links, ...(fromAddr ? { from: fromAddr } : {}), ...threadMeta } },
              recipients,
            );
          } catch {
            throw new PipelineError("encrypt_failed");
          }
          const hash = await senderHash(deps.senderHashSecret, route.userId, mail.from);

          // Claim the (event, mailbox) ledger row. A confirmed row (race) is left untouched.
          const claimedRow = await db
            .insert(arkivWrites)
            .values({ kind: "email", status: "submitted", webhookEventId: row.id, mailboxId: route.mailboxId, attempts: 1 })
            .onConflictDoUpdate({
              target: [arkivWrites.webhookEventId, arkivWrites.mailboxId],
              set: { status: "submitted", attempts: sql`${arkivWrites.attempts} + 1`, lastError: null },
              setWhere: sql`${arkivWrites.status} <> 'confirmed'`,
            })
            .returning({ id: arkivWrites.id });
          if (claimedRow.length === 0) {
            const [done] = await db
              .select({ entityKey: arkivWrites.entityKey })
              .from(arkivWrites)
              .where(and(eq(arkivWrites.webhookEventId, row.id), eq(arkivWrites.mailboxId, route.mailboxId)));
            if (done?.entityKey) confirmed.set(route.mailboxId, done.entityKey);
            continue;
          }
          const ledgerId = claimedRow[0]!.id;

          try {
            const res = await deps.arkiv.writeEmail({
              fields: {
                agentId: route.agentEnsName,
                ownerId: route.userWalletAddress,
                type: cls.type,
                receivedAt,
                threadId: threadId(deps.senderHashSecret, route.userId, mail),
                senderHash: hash,
                keyIds: enc.keyIds,
                ciphertext: enc.ciphertext,
                wrappedKeys: enc.wrappedKeys,
                nonce: enc.nonce,
              },
              ownerWallet: route.userWalletAddress,
              permissionlessExtension: cls.type !== "otp",
            });
            await db
              .update(arkivWrites)
              .set({ status: "confirmed", entityKey: res.entityKey, txHash: res.txHash, lastError: null })
              .where(eq(arkivWrites.id, ledgerId));
            confirmed.set(route.mailboxId, res.entityKey);
          } catch (err) {
            const code = writeCodeOf(err);
            await db
              .update(arkivWrites)
              .set({ status: "failed", lastError: code })
              .where(eq(arkivWrites.id, ledgerId))
              .catch(() => undefined);
            throw new PipelineError(code);
          }
        } catch (err) {
          failures.push(codeOf(err));
        }
      }
    }

    if (failures.length > 0 || confirmed.size < routes.size) {
      throw new PipelineError(failures[0] ?? "internal_error");
    }

    const entityKeys = [...routes.keys()].map((id) => confirmed.get(id)!);
    await finish("stored", { entityKey: entityKeys.join(",") });
    log({ event: "inbound", outcome: "stored", eventId, ...(type ? { type } : {}), entities: entityKeys.length });
    return { http: 200, status: "stored" };
  } catch (err) {
    const code = codeOf(err);
    await finish("failed", { error: code }).catch(() => undefined);
    log({ event: "inbound", outcome: "failed", eventId, code });
    return { http: 500, status: "failed" };
  }
}

interface TerminalFailure {
  error: string;
  /** API key / account configuration problem (logged as an error, the Resend error name only). */
  config?: boolean;
  /** Resend error name (a short token, never the message). */
  providerError?: string;
  /** Add the daily sent/received counts to the log line. */
  counts?: boolean;
}

/**
 * Provider failures that retrying can never fix. Everything else (5xx, network, timeouts, 408/425/429, 404) stays
 * retryable. Only fixed codes and the Resend error NAME are ever kept.
 */
export function terminalFetchFailure(err: unknown): TerminalFailure | null {
  if (!(err instanceof ProviderError)) return null;
  const { status, name } = err.detail;
  if (err.code === "provider_response_too_large") return { error: "response_too_large" };
  if (status === undefined) return null;
  if (status === 403 && name === "email_above_quota") return { error: "email_above_quota", providerError: name, counts: true };
  if (status === 401 || status === 403) return { error: PROVIDER_CONFIG_ERROR, config: true, providerError: name ?? `http_${status}` };
  if (status >= 400 && status < 500 && ![404, 408, 425, 429].includes(status)) {
    return { error: `provider_http_${status}`, ...(name ? { providerError: name } : {}) };
  }
  return null;
}

async function quotaCounts(deps: InboundDeps): Promise<Record<string, number>> {
  try {
    const c = await countMailSince(deps.db, utcDayStart(deps.now?.() ?? new Date()));
    return { sent: c.sent, received: c.received };
  } catch {
    return {};
  }
}

/** Map a writer error to a fixed, non-content code (error messages are never stored or logged). */
function writeCodeOf(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "EntityTooLargeError") return "entity_too_large";
  if (name === "InvalidEmailFieldsError") return "invalid_fields";
  if (name === "ArkivWriteError") return "arkiv_write_failed";
  return "internal_error";
}

function codeOf(err: unknown): string {
  if (err instanceof PipelineError) return err.code;
  const c = (err as { code?: unknown } | null)?.code;
  if (err instanceof Error && err.name === "ProviderError" && typeof c === "string") return c;
  return "internal_error";
}
