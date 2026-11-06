/*
 * Resend domain administration over the REST API (used by live-resend.ts). Plain fetch, injectable for tests.
 * Docs: https://resend.com/docs/api-reference/domains/{create-domain,list-domains,get-domain,verify-domain}.md
 *
 * Never prints or returns the API key. Errors carry the HTTP status and Resend's error `name` only.
 */

export const API_BASE = "https://api.resend.com";
export const REGIONS = ["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"] as const;
export type Region = (typeof REGIONS)[number];

export interface DomainRecord {
  /** Purpose label from Resend: "DKIM", "SPF", "Receiving", ... */
  record: string;
  /** Host name, relative to the parent zone of the domain (e.g. "send.nanitecom"). */
  name: string;
  type: string;
  ttl?: string;
  status: string;
  value: string;
  priority?: number;
}

export interface DomainInfo {
  id: string;
  name: string;
  status: string;
  region: string;
  capabilities: { sending?: string; receiving?: string };
  records: DomainRecord[];
}

/** Body of POST /domains: sending + receiving on, no tracking (no link rewriting, no open pixel), opportunistic TLS. */
export function buildCreateDomainBody(name: string, region: Region) {
  return {
    name,
    region,
    capabilities: { sending: "enabled", receiving: "enabled" },
    open_tracking: false,
    click_tracking: false,
    tls: "opportunistic",
  };
}

export class ResendAdminError extends Error {
  constructor(
    readonly status: number,
    readonly resendName: string | undefined,
    what: string,
  ) {
    super(`Resend ${what} answered ${status}${resendName ? ` ${resendName}` : ""}`);
    this.name = "ResendAdminError";
  }
}

export function createResendAdmin(apiKey: string, fetchImpl: typeof fetch = fetch) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    if (!res.ok) {
      const name = (json as { name?: unknown } | null)?.name;
      throw new ResendAdminError(res.status, typeof name === "string" && /^[a-z_]{1,64}$/.test(name) ? name : undefined, `${method} ${path}`);
    }
    return json as T;
  }

  const api = {
    /** All domains of the account (the list endpoint returns everything when `limit` is omitted). */
    async listDomains(): Promise<Array<Pick<DomainInfo, "id" | "name" | "status" | "region">>> {
      const r = await call<{ data?: Array<Pick<DomainInfo, "id" | "name" | "status" | "region">> }>("GET", "/domains");
      return r.data ?? [];
    },
    getDomain: (id: string) => call<DomainInfo>("GET", `/domains/${encodeURIComponent(id)}`),
    createDomain: (name: string, region: Region) => call<DomainInfo>("POST", "/domains", buildCreateDomainBody(name, region)),
    /** Starts the (asynchronous) verification of the DNS records. */
    verifyDomain: (id: string) => call<{ object: string; id: string }>("POST", `/domains/${encodeURIComponent(id)}/verify`),

    /** Idempotent: an existing domain with this name is fetched, never created again. */
    async ensureDomain(name: string, region: Region): Promise<{ domain: DomainInfo; created: boolean }> {
      const existing = (await api.listDomains()).find((d) => d.name.toLowerCase() === name.toLowerCase());
      if (existing) return { domain: await api.getDomain(existing.id), created: false };
      const made = await api.createDomain(name, region);
      // The create response already carries the records; the GET is the authoritative, complete view.
      return { domain: made.records?.length ? made : await api.getDomain(made.id), created: true };
    },
    async findDomain(name: string): Promise<DomainInfo | null> {
      const existing = (await api.listDomains()).find((d) => d.name.toLowerCase() === name.toLowerCase());
      return existing ? api.getDomain(existing.id) : null;
    },
  };
  return api;
}

/**
 * Resend names records relative to the PARENT zone of the domain it was given (domain `nanitecom.itsvikrant.tech`
 * -> `send.nanitecom`, zone `itsvikrant.tech`). For a root domain the names have no label suffix and the zone is the
 * domain itself.
 */
export function parentZone(domain: string, records: Pick<DomainRecord, "name">[]): string {
  const [label, ...rest] = domain.split(".");
  const underLabel = records.some((r) => r.name === label || r.name.endsWith(`.${label}`));
  return underLabel && rest.length >= 2 ? rest.join(".") : domain;
}

export function fqdn(recordName: string, zone: string): string {
  return recordName === "@" || recordName === "" ? zone : `${recordName}.${zone}`;
}

export interface RecordRow {
  purpose: string;
  type: string;
  /** Name relative to the zone (what most DNS panels want). */
  host: string;
  fqdn: string;
  value: string;
  priority: string;
  status: string;
}

/** The records of a domain as rows (full, untruncated values). A recommended DMARC row is appended. */
export function recordRows(d: DomainInfo): { zone: string; rows: RecordRow[] } {
  const zone = parentZone(d.name, d.records);
  const rows: RecordRow[] = d.records.map((r) => ({
    purpose: r.record,
    type: r.type,
    host: r.name,
    fqdn: fqdn(r.name, zone),
    value: r.value,
    priority: r.priority !== undefined && r.priority !== null ? String(r.priority) : "",
    status: r.status,
  }));
  const label = d.name.slice(0, d.name.length - zone.length - 1);
  const dmarcHost = zone === d.name ? "_dmarc" : `_dmarc.${label}`;
  rows.push({
    purpose: "DMARC (optional, recommended; not generated by Resend)",
    type: "TXT",
    host: dmarcHost,
    fqdn: fqdn(dmarcHost, zone),
    value: "v=DMARC1; p=none;",
    priority: "",
    status: "-",
  });
  return { zone, rows };
}

export function renderMarkdown(d: DomainInfo, today = new Date().toISOString().slice(0, 10)): string {
  const { zone, rows } = recordRows(d);
  const cap = d.capabilities;
  return [
    `# Resend DNS records for ${d.name}`,
    "",
    `Generated by \`apps/api/scripts/live-resend.ts\` on ${today} (overwritten on every run; DNS values are not secrets). Domain id \`${d.id}\`, region \`${d.region}\`, status \`${d.status}\`, sending ${cap.sending ?? "?"}, receiving ${cap.receiving ?? "?"}.`,
    "",
    `Add these in the DNS zone of \`${zone}\`. "Host" is relative to that zone; most DNS panels append \`.${zone}\` automatically.`,
    "",
    "| # | Purpose | Type | Host (in zone " + zone + ") | Full name | Value | Priority | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r, i) => `| ${i + 1} | ${r.purpose} | ${r.type} | \`${r.host}\` | ${r.fqdn} | \`${r.value}\` | ${r.priority} | ${r.status} |`),
    "",
    "Notes: a CNAME that is proxied in the DNS panel (e.g. Cloudflare orange cloud) must be set to DNS-only. TTL: Auto/default. After adding, run `--verify`; propagation can take minutes to hours.",
    "",
  ].join("\n");
}

/** Plain-text table for the terminal (values in full, one record per block so long values stay copyable). */
export function renderConsole(d: DomainInfo): string {
  const { zone, rows } = recordRows(d);
  const out = [`domain ${d.name}  id ${d.id}  status ${d.status}  region ${d.region}  sending=${d.capabilities.sending ?? "?"} receiving=${d.capabilities.receiving ?? "?"}`, `zone ${zone}`, ""];
  rows.forEach((r, i) => {
    out.push(`${i + 1}. ${r.purpose}  [${r.status}]`);
    out.push(`   type ${r.type}${r.priority ? `  priority ${r.priority}` : ""}`);
    out.push(`   host ${r.host}`);
    out.push(`   fqdn ${r.fqdn}`);
    out.push(`   value ${r.value}`);
  });
  return out.join("\n");
}
