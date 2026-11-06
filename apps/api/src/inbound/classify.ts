/*
 * Heuristic classification and extraction. Pure functions; inputs are untrusted email content.
 * Results (otp, links) are for the future agent API: they live in memory only and are put INSIDE the
 * encrypted payload, never in a plaintext Arkiv attribute, log line or Postgres row.
 */
import { createHmac } from "node:crypto";
import { htmlToText } from "@nanite/crypto";
import type { ReceivedEmail } from "../mail/provider.js";

export { classify, extractLinks, htmlToText, type Classification } from "@nanite/crypto";

export function bodyText(mail: Pick<ReceivedEmail, "text" | "html">): string {
  if (mail.text && mail.text.trim().length > 0) return mail.text;
  if (mail.html) return htmlToText(mail.html);
  return "";
}

/**
 * Text body limit stored per mail: 64 KiB of UTF-8. The Arkiv entity limit is about 125 KiB of ciphertext
 * (body + subject + meta incl. up to 20 links of 2 KiB), so this keeps a worst case below it.
 */
export const MAX_STORED_BODY_BYTES = 64 * 1024;
export const TRUNCATION_MARKER = "\n\n[Nanite: message truncated, it was longer than 64 KiB]";
const MAX_STORED_SUBJECT_CHARS = 998;

/** Cut `text` to `maxBytes` of UTF-8 (never mid-character) and append a marker. Short text is returned unchanged. */
export function capBody(text: string, maxBytes = MAX_STORED_BODY_BYTES): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1; // back up to a character boundary
  return { text: buf.subarray(0, end).toString("utf8") + TRUNCATION_MARKER, truncated: true };
}

export function capSubject(subject: string): string {
  return subject.length > MAX_STORED_SUBJECT_CHARS ? subject.slice(0, MAX_STORED_SUBJECT_CHARS) : subject;
}

const MSGID_RE = /<[^<>\s]+>/g;

/** "Name <A@B.c>" or "a@b.c" -> "a@b.c" (lowercase); null when it does not look like an address. */
export function parseFromAddress(raw: string): string | null {
  let a = raw.trim();
  const m = /<([^<>]+)>\s*$/.exec(a);
  if (m?.[1]) a = m[1];
  a = a.trim().toLowerCase();
  return a.length <= 254 && /^[^\s@<>,;]+@[^\s@<>,;]+$/.test(a) ? a : null;
}

/** Original Message-ID and References ids, for the encrypted meta (threading can use them later). */
export function threadingMeta(mail: Pick<ReceivedEmail, "messageId" | "headers">): { messageId?: string; references?: string[] } {
  const messageId = mail.messageId?.match(MSGID_RE)?.[0];
  const references = (mail.headers["references"]?.match(MSGID_RE) ?? []).slice(0, 20);
  return { ...(messageId ? { messageId } : {}), ...(references.length > 0 ? { references } : {}) };
}

/**
 * Opaque thread id. Thread root = first id in References, else In-Reply-To, else the mail's own
 * Message-ID, else the provider email id. The root is normalized (trim, lowercase) and hashed:
 * threadId = first 32 hex of HMAC-SHA256(HMAC-SHA256(secret, "nanite/thread-id/v1/user/" + userId), root).
 * Per-user key: the same conversation maps to different ids for different users, and the id reveals
 * nothing of the Message-ID header (which can embed hostnames or sender info).
 */
export function threadId(
  secret: string,
  userId: string,
  mail: Pick<ReceivedEmail, "id" | "messageId" | "headers">,
): string {
  const refs = mail.headers["references"]?.match(MSGID_RE) ?? [];
  const inReplyTo = mail.headers["in-reply-to"]?.match(MSGID_RE) ?? [];
  const root = refs[0] ?? inReplyTo[0] ?? mail.messageId?.match(MSGID_RE)?.[0] ?? `provider:${mail.id}`;
  return threadIdForRoot(secret, userId, root);
}

/**
 * The threadId for a known thread root (a Message-ID). Shared with the outbound sent copy so that a mail we send
 * and the replies to it land in the same thread: the sent copy uses the root of the chain it belongs to (first
 * References id when it is itself a reply, else the provider's Message-ID of the sent mail), and a reply to it
 * carries that same root in References / In-Reply-To.
 */
export function threadIdForRoot(secret: string, userId: string, root: string): string {
  const userKey = createHmac("sha256", secret).update(`nanite/thread-id/v1/user/${userId}`).digest();
  return createHmac("sha256", userKey).update(root.trim().toLowerCase()).digest("hex").slice(0, 32);
}
