/*
 * Heuristic classification and extraction. Pure functions; inputs are untrusted email content.
 * Results (otp, links) are for the future agent API: they live in memory only and are put INSIDE the
 * encrypted payload, never in a plaintext Arkiv attribute, log line or Postgres row.
 */
import { createHmac } from "node:crypto";
import type { EmailType } from "../arkiv/port.js";
import type { ReceivedEmail } from "../mail/provider.js";

const OTP_KEYWORDS =
  /\b(verification|verify|one[- ]time|otp|passcode|pass code|security code|login code|sign[- ]?in code|confirmation code|auth(?:entication)? code|2fa|two[- ]factor|your code|code is|pin)\b/i;
// A 4-8 digit code (optionally written "123 456" or "123-456") that is not part of a longer number.
const CODE_AFTER_KEYWORD =
  /\b(?:code|otp|passcode|pin|verification)\b[^\d\n]{0,40}?(?<![\d.,])(\d{3}[ -]?\d{3}|\d{4,8})(?![\d.,]?\d)/i;
const CODE_STANDALONE = /(?<![\d.,@#$€£-])(\d{6}|\d{4}|\d{8})(?![\d.,]?\d)/;
const URL_RE = /https?:\/\/[^\s<>"'()\]\[]+/gi;
const HREF_RE = /href\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
const MAX_LINKS = 20;
const MAX_URL_LEN = 2048;
/** Long mail is conversation even if it mentions a code. */
const OTP_MAX_BODY_CHARS = 2000;

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

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

export function extractLinks(text: string, html: string | null): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    const cleaned = raw.replace(/[.,;:!?]+$/, "");
    if (cleaned.length <= MAX_URL_LEN) found.add(cleaned);
  };
  if (html) for (const m of html.matchAll(HREF_RE)) add(m[1]!);
  for (const m of text.matchAll(URL_RE)) add(m[0]);
  return [...found].slice(0, MAX_LINKS);
}

export interface Classification {
  type: EmailType;
  otp?: string;
}

export function classify(subject: string, body: string): Classification {
  const keyworded = OTP_KEYWORDS.test(subject) || OTP_KEYWORDS.test(body);
  if (!keyworded || body.length > OTP_MAX_BODY_CHARS) return { type: "conversation" };
  const m = CODE_AFTER_KEYWORD.exec(body) ?? CODE_AFTER_KEYWORD.exec(subject);
  const raw = m?.[1] ?? CODE_STANDALONE.exec(subject)?.[1] ?? CODE_STANDALONE.exec(body)?.[1];
  if (!raw) return { type: "conversation" };
  const code = raw.replace(/[ -]/g, "");
  if (code.length < 4 || code.length > 8) return { type: "conversation" };
  return { type: "otp", otp: code };
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
  const userKey = createHmac("sha256", secret).update(`nanite/thread-id/v1/user/${userId}`).digest();
  return createHmac("sha256", userKey).update(root.trim().toLowerCase()).digest("hex").slice(0, 32);
}
