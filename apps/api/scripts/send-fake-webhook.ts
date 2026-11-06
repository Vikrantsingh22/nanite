/*
 * Manual check without Resend: signs and POSTs a sample `email.received` event to the API.
 *
 *   docker compose run --rm tools npx tsx apps/api/scripts/send-fake-webhook.ts [to-address] [--otp] [--fixture=newsletter]
 *
 * Env: RESEND_WEBHOOK_SECRET (must equal the api's; default is the dev secret below),
 *      WEBHOOK_URL (default http://api:4000/webhooks/resend).
 * NOTE: the API cannot fetch this fake email id from Resend. Start the api with FAKE_RESEND_CONTENT=1
 * (dev only) to serve a canned body (fixtures: conv, otp, newsletter, receipt, otp2), or use this script
 * only to check signature/dedupe/routing paths.
 */
import { DEV_WEBHOOK_SECRET, sendFakeWebhook } from "./lib/fake-webhook.js";

export { DEV_WEBHOOK_SECRET };

const args = process.argv.slice(2);
const to = args.find((a) => !a.startsWith("--")) ?? "alex@nanite.test";
const fixture = args.find((a) => a.startsWith("--fixture="))?.slice("--fixture=".length) ?? (args.includes("--otp") ? "otp" : "conv");

const res = await sendFakeWebhook({
  to,
  fixture,
  secret: process.env.RESEND_WEBHOOK_SECRET,
  url: process.env.WEBHOOK_URL,
});
console.log(res.status, res.body);
process.exit(res.status >= 200 && res.status < 300 ? 0 : 1);
