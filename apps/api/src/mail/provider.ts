/*
 * Mail provider interface. Resend is the first implementation (./resend.ts); the rest of the
 * API only depends on this file, so the provider can be swapped (see project summary, "Email module").
 *
 * Everything that comes out of a provider is untrusted input. Never log any of it except ids.
 */

/** Thrown by verifyWebhook on any failure. Carries no detail on purpose (the route answers 401 only). */
export class WebhookVerificationError extends Error {
  constructor() {
    super("webhook verification failed");
    this.name = "WebhookVerificationError";
  }
}

export interface HeaderBag {
  get(name: string): string | null | undefined;
}

/** A verified webhook event, reduced to what the pipeline needs. Metadata only, no content. */
export type InboundEvent =
  | {
      kind: "received";
      /** Stable per delivery attempt group (Svix message id); used for dedupe. */
      providerEventId: string;
      /** Provider id of the received email, used for fetchReceived. */
      emailId: string;
      /** Every address the mail was addressed to (to, cc, bcc, received_for), lowercased, deduped. */
      recipients: string[];
    }
  | {
      /** `domain.created` / `domain.updated` / `domain.deleted` (custom domain onboarding). Metadata only. */
      kind: "domain";
      providerEventId: string;
      type: string;
      domainId: string;
      status?: string;
      /** Raw `data.records` of the payload (validated by the domain service). */
      records?: unknown;
    }
  | { kind: "ignored"; providerEventId: string; type: string };

export interface ReceivedEmail {
  id: string;
  /** Raw From header value or address; only ever hashed (senderHash), never stored or logged. */
  from: string;
  to: string[];
  subject: string;
  /** Plain text body if the sender provided one. */
  text: string | null;
  html: string | null;
  /** Message-ID header value, e.g. "<abc@example.com>". */
  messageId: string | null;
  /** Headers with lowercased names; values joined with ", " if repeated. */
  headers: Record<string, string>;
}

export interface OutboundEmail {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  /** Sent as the Idempotency-Key request header (Resend keeps it 24 h). Not part of the message. */
  idempotencyKey?: string;
}

export interface MailProvider {
  /** Verify signature + timestamp over the RAW body. Throws WebhookVerificationError. */
  verifyWebhook(rawBody: Uint8Array, headers: HeaderBag): InboundEvent;
  /** Fetch the full content of a received email (the webhook only carries metadata). */
  fetchReceived(emailId: string): Promise<ReceivedEmail>;
  /** Send an email (POST /v1/emails/send, T3.5). */
  send(message: OutboundEmail): Promise<{ id: string }>;
  /**
   * The Message-ID the provider actually put on a sent mail (`GET /emails/{id}` -> `message_id`), "<...>" form,
   * or null if the provider has none yet. Resend/SES replace the Message-ID we could set, so this is the id that
   * later replies will carry in In-Reply-To / References. Throws ProviderError on HTTP/network failure.
   */
  getSentMessageId(id: string): Promise<string | null>;
}
