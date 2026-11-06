/*
 * Signs and POSTs a sample Resend `email.received` event to the API (used by send-fake-webhook.ts,
 * live-e2e.ts and seed-demo.ts). The API must run with FAKE_RESEND_CONTENT=1 so the content comes from
 * the canned fixtures in src/mail/fake.ts (`fake-<fixture>-<uuid>` email ids pick a fixture).
 */
import { randomUUID } from "node:crypto";
import { signSvix } from "../../src/mail/svix.js";

export const DEV_WEBHOOK_SECRET = "whsec_bmFuaXRlLWRldi13ZWJob29rLXNlY3JldC0xMjM0NTY=";

export interface FakeWebhookOptions {
  to: string;
  /** Fixture name from FAKE_FIXTURES (conv, otp, newsletter, receipt, otp2). Default conv. */
  fixture?: string;
  secret?: string | undefined;
  url?: string | undefined;
  from?: string;
  subject?: string;
}

export async function sendFakeWebhook(o: FakeWebhookOptions): Promise<{ status: number; body: string; emailId: string }> {
  const fixture = o.fixture ?? "conv";
  const secret = o.secret || DEV_WEBHOOK_SECRET;
  const url = o.url || "http://api:4000/webhooks/resend";
  const emailId = `fake-${fixture}-${randomUUID()}`;
  const body = JSON.stringify({
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: emailId,
      created_at: new Date().toISOString(),
      from: o.from ?? "Sender <sender@example.com>",
      to: [o.to],
      bcc: [],
      cc: [],
      received_for: [o.to],
      message_id: `<${randomUUID()}@example.com>`,
      subject: o.subject ?? "fake webhook",
      attachments: [],
    },
  });
  const id = `msg_${randomUUID().replace(/-/g, "")}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signSvix(secret, id, timestamp, body),
    },
    body,
  });
  return { status: res.status, body: await res.text(), emailId };
}
