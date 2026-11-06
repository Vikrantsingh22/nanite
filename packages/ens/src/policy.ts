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

// ---------- retention records (how long mail lives on Arkiv, and whether the agent may extend it) ----------

export const RETENTION_KEYS = {
  otpTtl: "nanite.otp-ttl",
  mailTtl: "nanite.mail-ttl",
  extend: "nanite.extend",
  extendLimit: "nanite.extend-limit",
} as const;

export const EXTEND_MODES = ["off", "on"] as const;
export type ExtendMode = (typeof EXTEND_MODES)[number];

export const DEFAULT_OTP_TTL_MINUTES = 5;
export const MIN_OTP_TTL_MINUTES = 1;
export const MAX_OTP_TTL_MINUTES = 60;
export const DEFAULT_MAIL_TTL_HOURS = 48;
export const MIN_MAIL_TTL_HOURS = 1;
/** 4380 h = 182.5 days = the Arkiv maximum lifetime (7,884,000 blocks of 2 s). */
export const MAX_MAIL_TTL_HOURS = 4380;
export const DEFAULT_EXTEND_MODE: ExtendMode = "on";
export const DEFAULT_EXTEND_LIMIT = 20;
export const MAX_EXTEND_LIMIT = 1000;

export interface RetentionPolicy {
  /** OTP lifetime in minutes (1..60). */
  otpTtlMinutes: number;
  /** Conversation and sent mail lifetime in hours (1..4380). */
  mailTtlHours: number;
  /** May the agent (token) extend mail? */
  extend: ExtendMode;
  /** Agent extensions per UTC day. */
  extendLimit: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  otpTtlMinutes: DEFAULT_OTP_TTL_MINUTES,
  mailTtlHours: DEFAULT_MAIL_TTL_HOURS,
  extend: DEFAULT_EXTEND_MODE,
  extendLimit: DEFAULT_EXTEND_LIMIT,
};

function parseIntIn(raw: string, min: number, max: number): number | null {
  if (!/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/**
 * Parse the four raw records. Missing/empty = default. A present but invalid value = default too (never throws,
 * never blocks mail); `invalid` counts those values so the caller can log a number, never the value.
 */
export function parseRetention(raw: {
  otpTtl?: string | null;
  mailTtl?: string | null;
  extend?: string | null;
  extendLimit?: string | null;
}): { policy: RetentionPolicy; invalid: number } {
  let invalid = 0;
  const num = (v: string | null | undefined, min: number, max: number, dflt: number) => {
    const t = v?.trim();
    if (!t) return dflt;
    const n = parseIntIn(t, min, max);
    if (n === null) {
      invalid++;
      return dflt;
    }
    return n;
  };
  const e = raw.extend?.trim().toLowerCase();
  let extend: ExtendMode = DEFAULT_EXTEND_MODE;
  if (e) {
    if ((EXTEND_MODES as readonly string[]).includes(e)) extend = e as ExtendMode;
    else invalid++;
  }
  return {
    policy: {
      otpTtlMinutes: num(raw.otpTtl, MIN_OTP_TTL_MINUTES, MAX_OTP_TTL_MINUTES, DEFAULT_OTP_TTL_MINUTES),
      mailTtlHours: num(raw.mailTtl, MIN_MAIL_TTL_HOURS, MAX_MAIL_TTL_HOURS, DEFAULT_MAIL_TTL_HOURS),
      extend,
      extendLimit: num(raw.extendLimit, 0, MAX_EXTEND_LIMIT, DEFAULT_EXTEND_LIMIT),
    },
    invalid,
  };
}

export const parseRetentionPolicy = (raw: Parameters<typeof parseRetention>[0]): RetentionPolicy => parseRetention(raw).policy;

/** Validate input for setRetentionPolicy; throws on bad input. Returns the record strings to write (only given fields). */
export function validateRetentionInput(input: {
  otpTtlMinutes?: number;
  mailTtlHours?: number;
  extend?: string;
  extendLimit?: number;
}): { otpTtl?: string; mailTtl?: string; extend?: ExtendMode; extendLimit?: string } {
  const out: { otpTtl?: string; mailTtl?: string; extend?: ExtendMode; extendLimit?: string } = {};
  const int = (v: number, name: string, min: number, max: number) => {
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`invalid ${name} ${v} (${min}..${max})`);
    return String(v);
  };
  if (input.otpTtlMinutes !== undefined) out.otpTtl = int(input.otpTtlMinutes, "otp lifetime", MIN_OTP_TTL_MINUTES, MAX_OTP_TTL_MINUTES);
  if (input.mailTtlHours !== undefined) out.mailTtl = int(input.mailTtlHours, "mail lifetime", MIN_MAIL_TTL_HOURS, MAX_MAIL_TTL_HOURS);
  if (input.extend !== undefined) {
    if (!(EXTEND_MODES as readonly string[]).includes(input.extend)) throw new Error(`invalid extend mode "${input.extend}"`);
    out.extend = input.extend as ExtendMode;
  }
  if (input.extendLimit !== undefined) out.extendLimit = int(input.extendLimit, "extend limit", 0, MAX_EXTEND_LIMIT);
  return out;
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
