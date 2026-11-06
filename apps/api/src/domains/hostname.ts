/*
 * Domain-name helpers for custom domain onboarding (T3.6): normalize what a user typed, validate it as a hostname,
 * find the registrable domain (the DNS zone root) with a small public-suffix approach, and express a Resend
 * record host relative to that zone. Pure functions, no I/O.
 */
import { domainToASCII } from "node:url";

/** Common two-label public suffixes. Anything else is treated as a one-label TLD. Deliberately small. */
const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in", "ac.in", "gov.in",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "co.nz", "org.nz", "net.nz", "govt.nz",
  "co.za", "org.za", "net.za",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "com.br", "net.br", "org.br", "com.cn", "net.cn", "org.cn", "com.mx", "com.ar", "com.co",
  "com.sg", "com.hk", "com.tw", "com.tr", "com.my", "com.ph", "com.pk", "com.ng", "com.eg", "com.ua", "com.vn",
  "co.id", "co.kr", "co.il", "co.th", "co.ke", "co.ug", "co.tz",
]);

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type NormalizeResult = { ok: true; name: string } | { ok: false };

/**
 * Lowercase, strip scheme, credentials, port, path and trailing dot; punycode IDNs; then validate as a hostname
 * (2+ labels, RFC label rules, alphabetic TLD, not an IP address).
 */
export function normalizeDomain(input: unknown): NormalizeResult {
  if (typeof input !== "string") return { ok: false };
  let s = input.trim().toLowerCase();
  if (s.length === 0 || s.length > 300) return { ok: false };
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0] ?? "";
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  s = s.replace(/:\d{1,5}$/, "");
  s = s.replace(/\.+$/, "");
  if (!s) return { ok: false };
  const ascii = domainToASCII(s);
  if (!ascii) return { ok: false };
  return isValidHostname(ascii) ? { ok: true, name: ascii } : { ok: false };
}

export function isValidHostname(name: string): boolean {
  if (name.length < 4 || name.length > 253) return false;
  const labels = name.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL_RE.test(l))) return false;
  const tld = labels[labels.length - 1]!;
  return /^[a-z]{2,63}$/.test(tld) || /^xn--[a-z0-9-]{1,59}$/.test(tld);
}

/** The registrable domain (DNS zone root): last two labels, or three under a known two-level suffix. */
export function registrableDomain(name: string): string {
  const labels = name.split(".");
  if (labels.length <= 2) return name;
  const last2 = labels.slice(-2).join(".");
  return TWO_LEVEL_SUFFIXES.has(last2) ? labels.slice(-3).join(".") : last2;
}

/** True when `name` equals `reserved` or is a subdomain of it. */
export function isSameOrSubdomain(name: string, reserved: string): boolean {
  return name === reserved || name.endsWith(`.${reserved}`);
}

/**
 * Express a Resend record name as a host relative to the zone root. Resend names records relative to the root of the
 * registrable domain (`send.nanitecom` for `nanitecom.itsvikrant.tech`). If a name is instead relative to the domain
 * itself (`send`, `@`), the domain's own label part is appended.
 */
export function zoneRelativeHost(domain: string, zoneRoot: string, recordName: string): string {
  const sub = domain === zoneRoot ? "" : domain.slice(0, domain.length - zoneRoot.length - 1);
  const n = recordName.trim().toLowerCase().replace(/\.+$/, "");
  const stripped = n.endsWith(`.${zoneRoot}`) ? n.slice(0, -(zoneRoot.length + 1)) : n === zoneRoot ? "@" : n;
  if (!sub) return stripped === "" ? "@" : stripped;
  if (stripped === sub || stripped.endsWith(`.${sub}`)) return stripped;
  if (stripped === "@" || stripped === "") return sub;
  return `${stripped}.${sub}`;
}

export function recordFqdn(host: string, zoneRoot: string): string {
  return host === "@" || host === "" ? zoneRoot : `${host}.${zoneRoot}`;
}
