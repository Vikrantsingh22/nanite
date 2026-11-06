/*
 * Svix webhook signature verification (Resend signs its webhooks with Svix).
 * Docs:
 *   Resend: https://resend.com/docs/webhooks/verify-webhooks-requests
 *   Svix manual algorithm: https://docs.svix.com/receiving/verifying-payloads/how-manual
 *
 * signedContent = `${svix-id}.${svix-timestamp}.${rawBody}`
 * key           = base64decode(secret without the "whsec_" prefix)
 * expected      = base64(HMAC-SHA256(key, signedContent))
 * svix-signature = space separated list of "v1,<base64>" entries; any one may match.
 * The timestamp (seconds) must be within the tolerance of now (both directions).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookVerificationError, type HeaderBag } from "./provider.js";

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export interface VerifySvixInput {
  secret: string;
  rawBody: Uint8Array;
  headers: HeaderBag;
  /** Current time in ms (injectable for tests). */
  nowMs?: number;
  toleranceSeconds?: number;
}

/** Returns the svix-id on success; throws WebhookVerificationError (no detail) otherwise. */
export function verifySvix(input: VerifySvixInput): string {
  const id = input.headers.get("svix-id");
  const timestamp = input.headers.get("svix-timestamp");
  const signatureHeader = input.headers.get("svix-signature");
  if (!id || !timestamp || !signatureHeader) throw new WebhookVerificationError();
  if (!/^\d{1,12}$/.test(timestamp)) throw new WebhookVerificationError();

  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const tolerance = input.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - Number(timestamp)) > tolerance) throw new WebhookVerificationError();

  const key = Buffer.from(input.secret.startsWith("whsec_") ? input.secret.slice(6) : input.secret, "base64");
  if (key.length === 0) throw new WebhookVerificationError();
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(input.rawBody)
    .digest();

  let ok = false;
  for (const entry of signatureHeader.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== "v1") continue;
    const candidate = Buffer.from(entry.slice(comma + 1), "base64");
    // Evaluate every candidate (no early exit) so timing does not reveal which one matched.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) ok = true;
  }
  if (!ok) throw new WebhookVerificationError();
  return id;
}

/** Test/dev helper: produce a valid svix-signature header value. */
export function signSvix(secret: string, id: string, timestamp: string, rawBody: Uint8Array | string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(rawBody).digest("base64");
  return `v1,${sig}`;
}
