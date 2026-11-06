/*
 * Sends ONE Svix-signed fake email.received event (random ids) to a public webhook URL, addressed to an unknown
 * address. Prints status and response body only.
 *   docker compose run --rm -e TUNNEL_URL=https://... tools npx tsx apps/api/scripts/live-webhook-selftest.ts
 */
import { sendFakeWebhook } from "./lib/fake-webhook.js";

const base = process.env.TUNNEL_URL?.replace(/\/+$/, "");
if (!base) throw new Error("TUNNEL_URL missing");
const r = await sendFakeWebhook({ to: "nobody-selftest@nanitecom.itsvikrant.tech", fixture: "conv", secret: process.env.RESEND_WEBHOOK_SECRET, url: `${base}/webhooks/resend` });
console.log(r.status, r.body, r.emailId);
