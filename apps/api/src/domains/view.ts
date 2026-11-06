/*
 * The domain view served to the browser, the check schedule and the small `{name, status}` summary used by /me.
 * Pure functions over a user_domains row.
 */
import type { UserDomainRow } from "@nanite/db";
import { PROVIDER_TIPS, recordKey, unquote, type DnsCheck, type DnsProvider } from "./dns.js";
import { recordFqdn, registrableDomain, zoneRelativeHost } from "./hostname.js";
import { parseRecords, type ResendDomainRecord } from "./resend-domains.js";

/** Minimum gap between two "verify now" requests for one domain. */
export const VERIFY_MIN_GAP_MS = 30_000;

/** Stored in `dns_check`: our lookup result plus the detected DNS provider. */
export type StoredDnsCheck = DnsCheck & { provider?: DnsProvider };

export interface DomainSummary {
  name: string;
  status: string;
}
export const domainSummary = (row: UserDomainRow | null): DomainSummary | null => (row ? { name: row.name, status: row.status } : null);

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * Background check cadence, by age since creation or the last manual/automatic verify:
 * every 15 s for 10 min, every 2 min up to 2 h, every 15 min up to 72 h, then stop (null).
 */
export function checkDelayMs(ageMs: number): number | null {
  if (ageMs < 10 * MIN) return 15_000;
  if (ageMs < 2 * HOUR) return 2 * MIN;
  if (ageMs < 72 * HOUR) return 15 * MIN;
  return null;
}

export const checkAnchor = (row: Pick<UserDomainRow, "createdAt" | "lastVerifyRequestedAt">): Date =>
  row.lastVerifyRequestedAt && row.lastVerifyRequestedAt > row.createdAt ? row.lastVerifyRequestedAt : row.createdAt;

export const readDnsCheck = (row: Pick<UserDomainRow, "dnsCheck">): StoredDnsCheck | null => {
  const c = row.dnsCheck as StoredDnsCheck | null;
  return c && typeof c === "object" && Array.isArray(c.records) && typeof c.checkedAt === "string" ? c : null;
};

/** When the background verifier should look at this domain next (null = never again / verified). */
export function nextCheckAt(row: UserDomainRow, now: Date): Date | null {
  if (row.status === "verified") return null;
  const last = readDnsCheck(row);
  const delay = checkDelayMs(now.getTime() - checkAnchor(row).getTime());
  if (delay === null) return null;
  return last ? new Date(Math.max(new Date(last.checkedAt).getTime() + delay, 0)) : now;
}

/** Records as stored, with the zone-relative host that the DNS panel needs. Values lose Resend's surrounding quotes. */
export function viewRecords(row: UserDomainRow) {
  const zone = registrableDomain(row.name);
  const recs = parseRecords(row.records) ?? [];
  const check = readDnsCheck(row);
  return recs.map((r: ResendDomainRecord) => {
    const host = zoneRelativeHost(row.name, zone, r.name);
    const found = check?.records.find((x) => x.key === recordKey({ type: r.type, host }))?.found;
    return {
      purpose: purposeOf(r),
      type: r.type.toUpperCase(),
      host,
      fqdn: recordFqdn(host, zone),
      value: unquote(r.value),
      ...(typeof r.priority === "number" ? { priority: r.priority } : {}),
      resendStatus: r.status,
      dnsFound: typeof found === "boolean" ? found : null,
    };
  });
}

function purposeOf(r: ResendDomainRecord): string {
  const rec = r.record.toLowerCase();
  const type = r.type.toUpperCase();
  if (rec.startsWith("dkim")) return "DKIM";
  if (rec.startsWith("receiving")) return "Receiving";
  if (rec === "spf") return type === "MX" ? "SPF bounce MX" : type === "CNAME" ? "SPF CNAME" : "SPF";
  return r.record || type;
}

export function domainView(row: UserDomainRow, now: Date) {
  const check = readDnsCheck(row);
  const provider: DnsProvider = check?.provider ?? "other";
  const next = nextCheckAt(row, now);
  const verifyAvailableAt = row.lastVerifyRequestedAt ? new Date(row.lastVerifyRequestedAt.getTime() + VERIFY_MIN_GAP_MS) : null;
  return {
    name: row.name,
    zone: registrableDomain(row.name),
    status: row.status,
    region: row.region,
    records: viewRecords(row),
    provider,
    providerTips: PROVIDER_TIPS[provider],
    lastCheckedAt: check?.checkedAt ?? null,
    nextCheckAt: next ? next.toISOString() : null,
    verifyAvailableAt: verifyAvailableAt && verifyAvailableAt > now ? verifyAvailableAt.toISOString() : null,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
  };
}
export type DomainView = ReturnType<typeof domainView>;
