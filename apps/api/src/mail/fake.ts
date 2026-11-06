/*
 * Fake MailProvider for tests and local dev (FAKE_RESEND_CONTENT=1). It reuses the real Resend
 * webhook verification (so signatures are still checked) and serves canned content instead of
 * calling the Receiving API. Never enabled in production.
 */
import type { MailProvider, OutboundEmail, ReceivedEmail } from "./provider.js";
import { createResendProvider } from "./resend.js";

export interface FakeMailProviderOptions {
  webhookSecret: string;
  /** Content by provider email id. Unknown ids get canned content (OTP if the id contains "otp"). */
  emails?: Record<string, Partial<ReceivedEmail>>;
  now?: () => number;
}

export interface FakeMailProvider extends MailProvider {
  /** Email ids that fetchReceived was called with. */
  readonly fetched: string[];
  /** Path + query of every receiving fetch (to check `?html_format=cid`). */
  readonly fetchedUrls: string[];
  /** Messages the fake "accepted" (successful sends only). */
  readonly sent: OutboundEmail[];
  /** Every POST /emails attempt, failed ones included. */
  readonly sendCalls: number;
  /** Queue provider failures: the next calls of that kind fail with these Resend-shaped errors, in order. */
  failNext(kind: "send" | "fetch" | "get", ...failures: FakeFailure[]): void;
  /** Number of GET /emails/{id} calls (sent-mail lookups), failed ones included. */
  readonly getCalls: number;
}

/**
 * Like Resend/Amazon SES, the fake REPLACES the Message-ID of every sent mail: whatever the caller put in
 * `headers["Message-ID"]` is ignored and `GET /emails/{id}` returns `message_id` = this SES-style id. Other
 * headers (In-Reply-To, References, X-Nanite-*) are kept, as on the first real email (2026-11-06).
 */
export const fakeProviderMessageId = (providerId: string): string => `<010601fake${providerId.replace(/[^a-z0-9]/gi, "")}-0000@eu-west-1.amazonses.com>`;

/**
 * Named demo fixtures, picked by a token in the email id: `fake-<fixture>-<anything>` (see
 * scripts/send-fake-webhook.ts `--fixture`). Everything here is invented text.
 */
export const FAKE_FIXTURES: Record<string, Partial<ReceivedEmail>> = {
  newsletter: {
    from: "Orbit Weekly <hello@orbit-weekly.example>",
    subject: "Orbit Weekly: five launches worth your time",
    text: "Orbit Weekly. This week: agents with their own inboxes, open-source mail servers and a new take on passkeys. Read online: https://orbit-weekly.example/issues/42",
    html:
      '<!doctype html><html><body style="font-family:Georgia,serif;max-width:560px;margin:0 auto">' +
      '<img src="https://orbit-weekly.example/img/banner.png" width="560" height="120" alt="Orbit Weekly">' +
      "<h1>Five launches worth your time</h1>" +
      "<p>This week: <b>agents with their own inboxes</b>, open-source mail servers and a new take on passkeys.</p>" +
      '<p><a href="https://orbit-weekly.example/issues/42">Read the full issue</a></p>' +
      '<img src="https://track.orbit-weekly.example/open.gif?u=demo" width="1" height="1" alt="">' +
      '<p style="color:#888;font-size:12px">You get this because you subscribed. <a href="https://orbit-weekly.example/unsubscribe?u=demo">Unsubscribe</a></p>' +
      "</body></html>",
  },
  conv: {
    from: "Dana Whitfield <dana@whitfield-studio.example>",
    subject: "Quick question about the onboarding draft",
    text:
      "Hi,\n\nThanks for sending the onboarding draft over. Two things before Friday: could you confirm the pricing table on page 3, and who owns the legal review? " +
      "The shared folder is here: https://drive.whitfield-studio.example/onboarding\n\nThanks,\nDana",
  },
  otp: {
    from: "Acme Security <no-reply@acme-auth.example>",
    subject: "Your Acme verification code",
    text: "Your verification code is 482913. It expires in 10 minutes. If you did not request it, ignore this email.",
  },
  receipt: {
    from: "Lumen Cloud Billing <billing@lumen-cloud.example>",
    subject: "Your receipt from Lumen Cloud (order LC-20817)",
    text: "Thanks for your payment of 24.00 USD for the Lumen Cloud Starter plan. Download the invoice: https://billing.lumen-cloud.example/invoices/LC-20817",
  },
  otp2: {
    from: "Northwind Bank <alerts@northwind-bank.example>",
    subject: "Northwind sign-in code",
    text: "Use passcode 731540 to finish signing in to Northwind. Never share this code with anyone.",
  },
};

export function fixtureOf(emailId: string): Partial<ReceivedEmail> | undefined {
  const m = /^fake-([a-z0-9]+)-/.exec(emailId);
  return m ? FAKE_FIXTURES[m[1]!] : undefined;
}

/**
 * An error as Resend documents it (https://resend.com/docs/api-reference/errors): HTTP status plus the JSON
 * body `{ statusCode, name, message }`. `retryAfter` (seconds) becomes the `retry-after` header; `network`
 * makes the call fail like a dropped connection (no response at all).
 */
export interface FakeFailure {
  status: number;
  name: string;
  message?: string;
  retryAfter?: number;
  network?: boolean;
}

/** Documented Resend errors the tests use (status + name as listed on the errors page). */
export const RESEND_ERRORS = {
  emailAboveQuota: { status: 403, name: "email_above_quota", message: "Email content can't be retrieved because it was over quota when received." },
  restrictedKey401: { status: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails." },
  restrictedKey403: { status: 403, name: "restricted_api_key", message: "API key is not active." },
  invalidKey: { status: 401, name: "validation_error", message: "API key is invalid." },
  domainNotVerified: { status: 403, name: "validation_error", message: "The domain is not verified." },
  dailyQuota: { status: 429, name: "daily_quota_exceeded", message: "You have reached your daily email sending quota." },
  monthlyQuota: { status: 429, name: "monthly_quota_exceeded", message: "You have reached your monthly email sending quota." },
  rateLimit: { status: 429, name: "rate_limit_exceeded", message: "Too many requests.", retryAfter: 1 },
  concurrentIdempotent: { status: 409, name: "concurrent_idempotent_requests", message: "Same idempotency key being used concurrently." },
  invalidIdempotent: { status: 409, name: "invalid_idempotent_request", message: "Same idempotency key used with a different payload." },
  applicationError: { status: 500, name: "application_error", message: "An unexpected error occurred." },
  unavailable: { status: 503, name: "service_unavailable", message: "The API is temporarily unavailable." },
  network: { status: 0, name: "network", network: true },
} as const satisfies Record<string, FakeFailure>;

/** Shape a ReceivedEmail the way GET /emails/receiving/{id} returns it (headers as an object, message_id in angle brackets). */
function receivedJson(mail: ReceivedEmail) {
  return {
    object: "email",
    id: mail.id,
    to: mail.to,
    from: mail.from,
    created_at: "2026-11-06T10:00:00.000Z",
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    headers: mail.headers,
    bcc: [],
    cc: [],
    reply_to: [],
    message_id: mail.messageId,
    raw: null,
    attachments: [],
  };
}

export function createFakeMailProvider(options: FakeMailProviderOptions): FakeMailProvider {
  const fetched: string[] = [];
  const fetchedUrls: string[] = [];
  const sent: OutboundEmail[] = [];
  const queued: Record<"send" | "fetch" | "get", FakeFailure[]> = { send: [], fetch: [], get: [] };
  let sendCalls = 0;
  let getCalls = 0;

  const failureResponse = (f: FakeFailure) => {
    if (f.network) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ statusCode: f.status, name: f.name, message: f.message ?? f.name }), {
      status: f.status,
      headers: { "content-type": "application/json", ...(f.retryAfter !== undefined ? { "retry-after": String(f.retryAfter) } : {}) },
    });
  };

  // The fake speaks Resend's HTTP API, so the REAL provider code (parsing, error handling) runs in every test.
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname.startsWith("/emails/receiving/")) {
      const emailId = decodeURIComponent(url.pathname.slice("/emails/receiving/".length));
      fetched.push(emailId);
      fetchedUrls.push(url.pathname + url.search);
      const failure = queued.fetch.shift();
      if (failure) return failureResponse(failure);
      const isOtp = emailId.includes("otp");
      const base: ReceivedEmail = {
        id: emailId,
        from: "Sender <sender@example.com>",
        to: ["alex@nanite.test"],
        subject: isOtp ? "Your verification code" : "Hello from the fake provider",
        text: isOtp
          ? "Your verification code is 482913. It expires in 10 minutes."
          : "Hi Alex, this is a canned conversation email. See https://example.com/docs for details.",
        html: null,
        messageId: `<${emailId}@example.com>`,
        headers: {},
      };
      return json(receivedJson({ ...base, ...fixtureOf(emailId), ...options.emails?.[emailId] }));
    }
    if (url.pathname === "/emails" && init?.method === "POST") {
      sendCalls += 1;
      const failure = queued.send.shift();
      if (failure) return failureResponse(failure);
      const body = JSON.parse(String(init.body)) as Omit<OutboundEmail, "idempotencyKey">;
      const key = new Headers(init.headers).get("idempotency-key");
      sent.push({ ...body, ...(key ? { idempotencyKey: key } : {}) });
      return json({ id: `fake-sent-${sent.length}` });
    }
    if (url.pathname.startsWith("/emails/") && (init?.method ?? "GET") === "GET") {
      getCalls += 1;
      const failure = queued.get.shift();
      if (failure) return failureResponse(failure);
      const id = decodeURIComponent(url.pathname.slice("/emails/".length));
      const m = /^fake-sent-(\d+)$/.exec(id);
      const mail = m ? sent[Number(m[1]) - 1] : undefined;
      if (!mail) return json({ statusCode: 404, name: "not_found", message: "Email not found." }, 404);
      return json({
        object: "email", id, to: mail.to, from: mail.from, created_at: "2026-11-06T10:00:00.000Z", subject: mail.subject,
        last_event: "delivered", message_id: fakeProviderMessageId(id), text: mail.text ?? null, html: mail.html ?? null,
      });
    }
    return json({ statusCode: 404, name: "not_found", message: "Route not found." }, 404);
  }) as typeof fetch;

  const real = createResendProvider({
    apiKey: "re_fake_key",
    webhookSecret: options.webhookSecret,
    fetch: fakeFetch,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    fetched,
    fetchedUrls,
    sent,
    get sendCalls() {
      return sendCalls;
    },
    get getCalls() {
      return getCalls;
    },
    failNext(kind, ...failures) {
      queued[kind].push(...failures);
    },
    verifyWebhook: (raw, headers) => real.verifyWebhook(raw, headers),
    fetchReceived: (emailId) => real.fetchReceived(emailId),
    send: (message) => real.send(message),
    getSentMessageId: (id) => real.getSentMessageId(id),
  };
}
