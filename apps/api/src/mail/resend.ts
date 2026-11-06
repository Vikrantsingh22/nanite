/*
 * Resend implementation of MailProvider (plain fetch, no SDK).
 *
 * Docs (checked 2026-11-06):
 *   Receiving overview:   https://resend.com/docs/dashboard/receiving/introduction
 *   Webhook payload:      https://resend.com/docs/dashboard/receiving/create-receiving-webhook
 *   Retrieve received:    https://resend.com/docs/api-reference/emails/retrieve-received-email
 *   Verify webhooks:      https://resend.com/docs/webhooks/verify-webhooks-requests (Svix, see ./svix.ts)
 *   Send:                 https://resend.com/docs/api-reference/emails/send-email
 *
 * email.received webhook body (metadata only, no body text):
 *   { type: "email.received", created_at, data: { email_id, created_at, from, to[], bcc[], cc[],
 *     received_for[], message_id, subject, attachments[] } }
 * Full content: GET https://api.resend.com/emails/receiving/{email_id} (Bearer API key) returning
 *   { id, to[], from, subject, html, text, headers{}, message_id, authentication{spf,dkim,dmarc}, raw{download_url}, ... }
 */
import {
  WebhookVerificationError,
  type HeaderBag,
  type InboundEvent,
  type MailProvider,
  type OutboundEmail,
  type ReceivedEmail,
} from "./provider.js";
import { verifySvix } from "./svix.js";

const API_BASE = "https://api.resend.com";
const FETCH_TIMEOUT_MS = 10_000;
/**
 * Hard cap on one received-email response. With `html_format=cid` inline images stay out of the HTML, so a normal
 * mail is far below this; a bigger one is refused (terminal) instead of being buffered in memory.
 */
export const MAX_RECEIVED_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

export interface ResendProviderOptions {
  apiKey: string;
  webhookSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface ProviderErrorDetail {
  /** HTTP status of the provider answer (absent for network errors). */
  status?: number;
  /** Resend error `name` (e.g. "email_above_quota"), only if it is a short [a-z_] token. Never the message. */
  name?: string;
  /** Parsed `retry-after` header in milliseconds. */
  retryAfterMs?: number;
}

/** Error whose message is a fixed code (never response content). */
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly detail: ProviderErrorDetail = {},
  ) {
    super(code);
    this.name = "ProviderError";
  }
}

/** Resend error body: `{ statusCode, name, message }`. Only the `name` token is ever used. */
function parseErrorName(text: string): string | undefined {
  try {
    const name = (JSON.parse(text) as { name?: unknown } | null)?.name;
    return typeof name === "string" && /^[a-z_]{1,64}$/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

function parseRetryAfterMs(res: Response): number | undefined {
  const v = res.headers.get("retry-after");
  if (!v) return undefined;
  const s = Number(v);
  return Number.isFinite(s) && s >= 0 ? Math.round(s * 1000) : undefined;
}

/** Read a body as text but stop at `max` bytes. Returns null when the body is bigger. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const len = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > max) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** "Name <a@b.c>" -> "a@b.c", lowercased. */
export function extractAddress(value: string): string {
  const m = /<([^<>]+)>\s*$/.exec(value);
  return (m?.[1] ?? value).trim().toLowerCase();
}

export function createResendProvider(options: ResendProviderOptions): MailProvider {
  const doFetch = options.fetch ?? fetch;
  const auth = { Authorization: `Bearer ${options.apiKey}` };

  async function call(path: string, init: RequestInit, maxBytes = MAX_ERROR_BODY_BYTES): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${API_BASE}${path}`, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      throw new ProviderError("provider_unreachable");
    }
    if (!res.ok) {
      let name: string | undefined;
      try {
        const text = await readCapped(res, MAX_ERROR_BODY_BYTES);
        name = text === null ? undefined : parseErrorName(text);
      } catch {
        /* the status alone is enough */
      }
      const retryAfterMs = parseRetryAfterMs(res);
      throw new ProviderError(`provider_http_${res.status}`, {
        status: res.status,
        ...(name ? { name } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    let text: string | null;
    try {
      text = await readCapped(res, maxBytes);
    } catch {
      throw new ProviderError("provider_unreachable");
    }
    if (text === null) throw new ProviderError("provider_response_too_large", { status: res.status });
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError("provider_bad_response");
    }
  }

  return {
    verifyWebhook(rawBody: Uint8Array, headers: HeaderBag): InboundEvent {
      const providerEventId = verifySvix({
        secret: options.webhookSecret,
        rawBody,
        headers,
        ...(options.now ? { nowMs: options.now() } : {}),
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
      } catch {
        throw new WebhookVerificationError();
      }
      const body = parsed as { type?: unknown; data?: Record<string, unknown> };
      if (body.type === "domain.created" || body.type === "domain.updated" || body.type === "domain.deleted") {
        const d = body.data ?? {};
        const id = typeof d.id === "string" ? d.id : typeof d.domain_id === "string" ? d.domain_id : "";
        if (!id || id.length > 128) throw new WebhookVerificationError();
        return {
          kind: "domain",
          providerEventId,
          type: body.type,
          domainId: id,
          ...(typeof d.status === "string" ? { status: d.status } : {}),
          ...(d.records !== undefined ? { records: d.records } : {}),
        };
      }
      if (body.type !== "email.received") {
        return { kind: "ignored", providerEventId, type: typeof body.type === "string" ? body.type.slice(0, 64) : "unknown" };
      }
      const data = body.data ?? {};
      if (typeof data.email_id !== "string" || data.email_id.length === 0 || data.email_id.length > 128) {
        throw new WebhookVerificationError();
      }
      const recipients = [
        ...new Set(
          [...asStringArray(data.received_for), ...asStringArray(data.to), ...asStringArray(data.cc), ...asStringArray(data.bcc)]
            .map(extractAddress)
            .filter((a) => a.length > 0),
        ),
      ].slice(0, 50);
      return { kind: "received", providerEventId, emailId: data.email_id, recipients };
    },

    async fetchReceived(emailId: string): Promise<ReceivedEmail> {
      // html_format=cid: inline images stay `cid:` references instead of base64 data URIs (which can be up to 100 MB).
      // https://resend.com/docs/api-reference/emails/retrieve-received-email
      const json = (await call(
        `/emails/receiving/${encodeURIComponent(emailId)}?html_format=cid`,
        { headers: auth },
        MAX_RECEIVED_RESPONSE_BYTES,
      )) as Record<string, unknown>;
      const headers: Record<string, string> = {};
      if (json.headers && typeof json.headers === "object") {
        for (const [k, v] of Object.entries(json.headers as Record<string, unknown>)) {
          const val = Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : null;
          if (val !== null) headers[k.toLowerCase()] = val;
        }
      }
      return {
        id: typeof json.id === "string" ? json.id : emailId,
        from: typeof json.from === "string" ? json.from : "",
        to: asStringArray(json.to),
        subject: typeof json.subject === "string" ? json.subject : "",
        text: typeof json.text === "string" ? json.text : null,
        html: typeof json.html === "string" ? json.html : null,
        messageId: typeof json.message_id === "string" ? json.message_id : (headers["message-id"] ?? null),
        headers,
      };
    },

    async send(message: OutboundEmail): Promise<{ id: string }> {
      // https://resend.com/docs/api-reference/emails/send-email : body {from,to,subject,text,html,headers}, optional Idempotency-Key header.
      const { idempotencyKey, ...payload } = message;
      const json = (await call("/emails", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
        body: JSON.stringify(payload),
      })) as { id?: unknown };
      if (typeof json.id !== "string") throw new ProviderError("provider_bad_response");
      return { id: json.id };
    },

    async getSentMessageId(id: string): Promise<string | null> {
      // https://resend.com/docs/api-reference/emails/retrieve-email : returns message_id (the id SES put on the mail).
      const json = (await call(`/emails/${encodeURIComponent(id)}`, { headers: auth })) as { message_id?: unknown } | null;
      const raw = typeof json?.message_id === "string" ? json.message_id.trim() : "";
      if (!raw) return null;
      const id2 = /^<[^<>\s]+>$/.test(raw) ? raw : /^[^<>\s]+$/.test(raw) ? `<${raw}>` : null; // tolerate a bare id
      return id2 && id2.length <= 202 ? id2 : null;
    },
  };
}
