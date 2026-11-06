/*
 * Public DNS lookups for custom domain onboarding (T3.6): DNS over HTTPS to Cloudflare (application/dns-json)
 * behind a small injectable resolver, per-record "is it in DNS yet" checks, and DNS provider detection.
 * Only public DNS data is handled here.
 */
import { recordFqdn } from "./hostname.js";

export type DnsQueryType = "MX" | "NS" | "TXT" | "CNAME";

export interface DnsResolver {
  /**
   * Normalized answers: MX "<priority> <host>", NS/CNAME "<host>" (lowercase, no trailing dot), TXT the unquoted
   * text (multi-part strings joined). `[]` = the name has no such record; `null` = the lookup failed (unknown).
   */
  query(name: string, type: DnsQueryType): Promise<string[] | null>;
}

const TYPE_CODE: Record<DnsQueryType, number> = { MX: 15, NS: 2, TXT: 16, CNAME: 5 };
const DOH_URL = "https://cloudflare-dns.com/dns-query";

const stripDot = (s: string) => s.trim().replace(/\.+$/, "").toLowerCase();

export function normalizeAnswer(type: DnsQueryType, data: string): string {
  if (type === "TXT") {
    const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1"));
    return parts.length > 0 ? parts.join("") : data;
  }
  if (type === "MX") {
    const m = /^(\d+)\s+(.+)$/.exec(data.trim());
    return m ? `${m[1]} ${stripDot(m[2]!)}` : stripDot(data);
  }
  return stripDot(data);
}

export function createDohResolver(opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): DnsResolver {
  const doFetch = opts.fetch ?? fetch;
  return {
    async query(name, type) {
      try {
        const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`;
        const res = await doFetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
        if (!res.ok) return null;
        const json = (await res.json()) as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
        if (json.Status === 3) return []; // NXDOMAIN
        if (json.Status !== 0) return null;
        return (json.Answer ?? [])
          .filter((a) => a.type === TYPE_CODE[type] && typeof a.data === "string")
          .map((a) => normalizeAnswer(type, a.data!));
      } catch {
        return null;
      }
    },
  };
}

// ---------- per-record checks ----------

export interface CheckableRecord {
  type: string;
  host: string;
  value: string;
}

export interface DnsRecordResult {
  key: string;
  found: boolean | null;
}

export interface DnsCheck {
  checkedAt: string;
  allFound: boolean;
  records: DnsRecordResult[];
}

export const recordKey = (r: { type: string; host: string }) => `${r.type.toUpperCase()}|${r.host}`;

const squash = (s: string) => s.replace(/\s+/g, "");
export const unquote = (s: string) => s.trim().replace(/^"(.*)"$/s, "$1");

export function answerMatches(type: string, expected: string, answers: string[]): boolean {
  const want = unquote(expected);
  switch (type.toUpperCase()) {
    case "TXT": {
      const w = squash(want);
      return answers.some((a) => squash(a).includes(w));
    }
    case "CNAME":
      return answers.some((a) => a === stripDot(want));
    case "MX":
      return answers.some((a) => a.replace(/^\d+\s+/, "") === stripDot(want));
    default:
      return false;
  }
}

export async function checkRecords(records: CheckableRecord[], zoneRoot: string, dns: DnsResolver, now: Date): Promise<DnsCheck> {
  const results = await Promise.all(
    records.map(async (r): Promise<DnsRecordResult> => {
      const type = r.type.toUpperCase();
      if (type !== "TXT" && type !== "CNAME" && type !== "MX") return { key: recordKey(r), found: null };
      const answers = await dns.query(recordFqdn(r.host, zoneRoot), type);
      return { key: recordKey(r), found: answers === null ? null : answerMatches(type, r.value, answers) };
    }),
  );
  return { checkedAt: now.toISOString(), allFound: results.length > 0 && results.every((x) => x.found === true), records: results };
}

// ---------- provider detection ----------

export type DnsProvider = "cloudflare" | "godaddy" | "namecheap" | "route53" | "google" | "other";

export function detectProvider(nameservers: string[]): DnsProvider {
  const ns = nameservers.map((n) => n.toLowerCase());
  const has = (re: RegExp) => ns.some((n) => re.test(n));
  if (has(/\.ns\.cloudflare\.com$/)) return "cloudflare";
  if (has(/\.domaincontrol\.com$/)) return "godaddy";
  if (has(/\.registrar-servers\.com$/) || has(/\.namecheaphosting\.com$/)) return "namecheap";
  if (has(/^ns-\d+\.awsdns-/)) return "route53";
  if (has(/\.googledomains\.com$/) || has(/^ns-cloud-/) || has(/\.google\.com$/)) return "google";
  return "other";
}

export const PROVIDER_TIPS: Record<DnsProvider, string[]> = {
  cloudflare: [
    "Cloudflare: set the CNAME record to \"DNS only\" (grey cloud). A proxied (orange cloud) CNAME will not verify.",
    "Cloudflare: use priority 10 for MX records, and enter the host only (Cloudflare appends your domain).",
  ],
  godaddy: [
    "GoDaddy: enter the host only (for example send.mail), not the full name. GoDaddy adds your domain.",
    "GoDaddy: use priority 10 for MX records and leave TTL at the default.",
  ],
  namecheap: [
    "Namecheap: open Advanced DNS and enter the host only; Namecheap adds your domain.",
    "Namecheap: use priority 10 for MX records. If Mail Settings is set to \"Custom MX\", add the MX there too.",
  ],
  route53: [
    "Route 53: enter the host only in the Record name field, with the hosted zone selected.",
    "Route 53: TXT values must be wrapped in double quotes, and the MX value is \"10 <host>\" (priority first).",
  ],
  google: [
    "Google Cloud DNS or Google Domains: enter the host only. The panel adds your domain.",
    "Use priority 10 for MX records. TXT values may need to be wrapped in double quotes.",
  ],
  other: [
    "Most DNS panels add your domain automatically, so enter the host only (for example send.mail).",
    "Use priority 10 for MX records. If your panel proxies records, turn the proxy off for the CNAME.",
  ],
};
