// Shared, pure mail heuristics (browser- and Node-safe, no I/O): OTP classification, link extraction, HTML to text and
// reply-threading headers. The API (inbound pipeline, outbound threading) and the self-hosted agent kit use the SAME
// functions, so a locally decrypted mail yields the same codes and links as the hosted API. Inputs are untrusted.

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
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export function extractLinks(text: string, html: string | null): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    const cleaned = raw.replace(/[.,;:!?]+$/, '');
    if (cleaned.length <= MAX_URL_LEN) found.add(cleaned);
  };
  if (html) for (const m of html.matchAll(HREF_RE)) add(m[1]!);
  for (const m of text.matchAll(URL_RE)) add(m[0]);
  return [...found].slice(0, MAX_LINKS);
}

export interface Classification {
  type: 'otp' | 'conversation';
  otp?: string;
}

export function classify(subject: string, body: string): Classification {
  const keyworded = OTP_KEYWORDS.test(subject) || OTP_KEYWORDS.test(body);
  if (!keyworded || body.length > OTP_MAX_BODY_CHARS) return { type: 'conversation' };
  const m = CODE_AFTER_KEYWORD.exec(body) ?? CODE_AFTER_KEYWORD.exec(subject);
  const raw = m?.[1] ?? CODE_STANDALONE.exec(subject)?.[1] ?? CODE_STANDALONE.exec(body)?.[1];
  if (!raw) return { type: 'conversation' };
  const code = raw.replace(/[ -]/g, '');
  if (code.length < 4 || code.length > 8) return { type: 'conversation' };
  return { type: 'otp', otp: code };
}

/** One RFC 5322 msg-id: `<...>` with no whitespace, CR/LF or angle brackets inside. Anything else is dropped. */
export const MSGID_RE = /^<[^<>\s]{1,200}>$/;
export const MAX_REFERENCES = 20;
export const MAX_REFERENCES_CHARS = 900;

export interface ThreadLinks {
  /** The Message-ID being answered. */
  inReplyTo: string;
  /** Its References (oldest first) followed by its own Message-ID. */
  references: string[];
}

/**
 * In-Reply-To / References for a reply to a mail with this `messageId` and `references` (from its decrypted meta, or
 * supplied by a self-hosted agent). Invalid ids are dropped; null when the answered id itself is unusable.
 */
export function buildThreadLinks(messageId: unknown, references: unknown): ThreadLinks | null {
  if (typeof messageId !== 'string' || !MSGID_RE.test(messageId)) return null;
  const refs = Array.isArray(references)
    ? references.filter((r): r is string => typeof r === 'string' && MSGID_RE.test(r))
    : [];
  const chain = [...new Set([...refs, messageId])]; // dedupe, keep order; the answered id is last
  while (chain.length > 2 && (chain.length > MAX_REFERENCES || chain.join(' ').length > MAX_REFERENCES_CHARS)) chain.splice(1, 1); // keep the root and the newest
  return { inReplyTo: messageId, references: chain };
}
