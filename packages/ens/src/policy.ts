// Send-policy records (outbound email permitted by ENS). Pure parsing/validation, no I/O.
export const SEND_KEYS = {
  policy: "nanite.send",
  allow: "nanite.send-allow",
  limit: "nanite.send-limit",
} as const;

export const SEND_POLICIES = ["off", "reply-only", "allowlist", "any"] as const;
export type SendPolicyMode = (typeof SEND_POLICIES)[number];

export const DEFAULT_SEND_POLICY: SendPolicyMode = "reply-only";
export const DEFAULT_SEND_LIMIT = 50;
export const MAX_SEND_LIMIT = 10_000;

export interface SendPolicy {
  policy: SendPolicyMode;
  /** Allowed recipients: addresses, `@domain` or ENS names. Lower-cased. */
  allow: string[];
  /** Max sends per day. */
  limit: number;
}

const ADDRESS_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const DOMAIN_RE = /^@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const ENS_RE = /^([a-z0-9-]+\.)+eth$/;

export function isSendPolicyMode(v: unknown): v is SendPolicyMode {
  return typeof v === "string" && (SEND_POLICIES as readonly string[]).includes(v);
}

export function isValidAllowEntry(entry: string): boolean {
  return ADDRESS_RE.test(entry) || DOMAIN_RE.test(entry) || ENS_RE.test(entry);
}

/** Parse a comma-separated allowlist. Returns null if any entry is malformed. */
export function parseAllowList(raw: string): string[] | null {
  const items = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return items.every(isValidAllowEntry) ? items : null;
}

export function parseLimit(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n <= MAX_SEND_LIMIT ? n : null;
}

/**
 * Parse the three raw text records into a typed policy. Fails CLOSED: a missing policy is the default
 * (`reply-only`), but a present-and-invalid value means `off` / limit 0 / empty allowlist, never
 * a more permissive reading.
 */
export function parseSendPolicy(raw: {
  policy?: string | null;
  allow?: string | null;
  limit?: string | null;
}): SendPolicy {
  const p = raw.policy?.trim();
  const policy: SendPolicyMode = !p ? DEFAULT_SEND_POLICY : isSendPolicyMode(p) ? p : "off";
  const a = raw.allow?.trim();
  const allow = !a ? [] : (parseAllowList(a) ?? []);
  const l = raw.limit?.trim();
  const limit = !l ? DEFAULT_SEND_LIMIT : (parseLimit(l) ?? 0);
  return { policy, allow, limit };
}

/** Validate operator/dashboard input for setSendPolicy; throws on bad input. Returns record strings. */
export function validateSendPolicyInput(input: {
  policy: string;
  allow?: string[];
  limit?: number;
}): { policy: SendPolicyMode; allow?: string; limit?: string } {
  if (!isSendPolicyMode(input.policy)) throw new Error(`invalid send policy "${input.policy}"`);
  const out: { policy: SendPolicyMode; allow?: string; limit?: string } = { policy: input.policy };
  if (input.allow !== undefined) {
    const norm = input.allow.map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const e of norm) if (!isValidAllowEntry(e)) throw new Error(`invalid allowlist entry "${e}"`);
    out.allow = norm.join(",");
  }
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 0 || input.limit > MAX_SEND_LIMIT) {
      throw new Error(`invalid send limit ${input.limit} (0..${MAX_SEND_LIMIT})`);
    }
    out.limit = String(input.limit);
  }
  return out;
}
