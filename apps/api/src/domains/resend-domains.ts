/*
 * Resend domain administration for custom domain onboarding (T3.6), behind a port so tests use a fake.
 * Docs: https://resend.com/docs/api-reference/domains/{create-domain,list-domains,get-domain,verify-domain,delete-domain}
 *
 * Never returns or logs the API key. Errors carry the HTTP status, Resend's error `name` token and a short
 * message (used only to classify errors; never logged).
 */

export const RESEND_REGIONS = ["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"] as const;
export type ResendRegion = (typeof RESEND_REGIONS)[number];
export const isResendRegion = (v: unknown): v is ResendRegion => typeof v === "string" && (RESEND_REGIONS as readonly string[]).includes(v);

export interface ResendDomainRecord {
  /** Purpose label from Resend: "DKIM", "SPF", "Receiving", ... */
  record: string;
  /** Host relative to the zone root. */
  name: string;
  type: string;
  value: string;
  ttl?: string;
  status: string;
  priority?: number;
}

export interface ResendDomain {
  id: string;
  name: string;
  status: string;
  region: string;
  records: ResendDomainRecord[];
}

export interface ResendDomainsPort {
  listDomains(): Promise<Array<Pick<ResendDomain, "id" | "name" | "status" | "region">>>;
  getDomain(id: string): Promise<ResendDomain>;
  createDomain(name: string, region: ResendRegion): Promise<ResendDomain>;
  verifyDomain(id: string): Promise<void>;
  deleteDomain(id: string): Promise<void>;
}

export class ResendDomainError extends Error {
  constructor(
    readonly status: number,
    readonly resendName: string | undefined,
    readonly resendMessage: string,
  ) {
    super(`resend_domains_${status}${resendName ? `_${resendName}` : ""}`);
    this.name = "ResendDomainError";
  }
}

export type DomainErrorKind = "limit" | "taken" | "invalid" | "key" | "not_found" | "unavailable";

/** Maps a Resend failure to what the API tells the browser. */
export function classifyDomainError(e: unknown): DomainErrorKind {
  if (!(e instanceof ResendDomainError)) return "unavailable";
  const msg = e.resendMessage.toLowerCase();
  if (e.resendName === "domain_limit_reached" || (e.status === 403 && /limit|upgrade|plan/.test(msg))) return "limit";
  if (e.status === 401 || e.resendName === "restricted_api_key" || e.resendName === "missing_api_key" || e.resendName === "invalid_api_key") return "key";
  if (e.status === 403 && /already|registered|exist|taken/.test(msg)) return "taken";
  if (e.status === 409) return "taken";
  if (e.status === 404) return "not_found";
  if (e.status === 400 || e.status === 422 || e.resendName === "validation_error" || e.resendName === "invalid_region") return "invalid";
  if (e.status === 403) return "key";
  return "unavailable";
}

const asRecord = (r: unknown): ResendDomainRecord | null => {
  const o = r as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.type !== "string" || typeof o.name !== "string" || typeof o.value !== "string") return null;
  return {
    record: typeof o.record === "string" ? o.record : "",
    name: o.name,
    type: o.type,
    value: o.value,
    ...(typeof o.ttl === "string" ? { ttl: o.ttl } : {}),
    status: typeof o.status === "string" ? o.status : "not_started",
    ...(typeof o.priority === "number" ? { priority: o.priority } : {}),
  };
};

/** Validates records from a Resend response or webhook; null when the shape is unusable. */
export function parseRecords(v: unknown): ResendDomainRecord[] | null {
  if (!Array.isArray(v)) return null;
  const out: ResendDomainRecord[] = [];
  for (const r of v) {
    const rec = asRecord(r);
    if (!rec) return null;
    out.push(rec);
  }
  return out;
}

function parseDomain(json: unknown): ResendDomain {
  const o = json as Record<string, unknown> | null;
  if (!o || typeof o.id !== "string" || typeof o.name !== "string") throw new ResendDomainError(502, "bad_response", "");
  return {
    id: o.id,
    name: o.name.toLowerCase(),
    status: typeof o.status === "string" ? o.status : "not_started",
    region: typeof o.region === "string" ? o.region : "",
    records: parseRecords(o.records) ?? [],
  };
}

export function createResendDomains(opts: { apiKey: string; fetch?: typeof fetch }): ResendDomainsPort {
  const doFetch = opts.fetch ?? fetch;
  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`https://api.resend.com${path}`, {
        method,
        headers: { Authorization: `Bearer ${opts.apiKey}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ResendDomainError(0, "unreachable", "");
    }
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    if (!res.ok) {
      const j = json as { name?: unknown; message?: unknown } | null;
      const name = typeof j?.name === "string" && /^[a-z_]{1,64}$/.test(j.name) ? j.name : undefined;
      throw new ResendDomainError(res.status, name, typeof j?.message === "string" ? j.message.slice(0, 300) : "");
    }
    return json;
  }
  const enc = encodeURIComponent;
  return {
    async listDomains() {
      const r = (await call("GET", "/domains")) as { data?: Array<Record<string, unknown>> } | null;
      return (r?.data ?? []).filter((d) => typeof d.id === "string" && typeof d.name === "string").map((d) => ({
        id: d.id as string,
        name: (d.name as string).toLowerCase(),
        status: typeof d.status === "string" ? d.status : "not_started",
        region: typeof d.region === "string" ? d.region : "",
      }));
    },
    async getDomain(id) {
      return parseDomain(await call("GET", `/domains/${enc(id)}`));
    },
    async createDomain(name, region) {
      const made = parseDomain(
        await call("POST", "/domains", {
          name,
          region,
          capabilities: { sending: "enabled", receiving: "enabled" },
          open_tracking: false,
          click_tracking: false,
          tls: "opportunistic",
        }),
      );
      // The GET is the authoritative, complete view (the create response may omit records).
      return made.records.length > 0 ? made : parseDomain(await call("GET", `/domains/${enc(made.id)}`));
    },
    async verifyDomain(id) {
      await call("POST", `/domains/${enc(id)}/verify`);
    },
    async deleteDomain(id) {
      await call("DELETE", `/domains/${enc(id)}`);
    },
  };
}
