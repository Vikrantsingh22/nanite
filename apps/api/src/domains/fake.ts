/*
 * In-memory fakes for custom domain onboarding: a Resend domains API and a DNS resolver. Used by the tests and by
 * dev stacks started with FAKE_RESEND_DOMAINS=1 (never in production). No network.
 */
import type { DnsQueryType, DnsResolver } from "./dns.js";
import { recordFqdn, registrableDomain, zoneRelativeHost } from "./hostname.js";
import { ResendDomainError, type ResendDomain, type ResendDomainRecord, type ResendDomainsPort, type ResendRegion } from "./resend-domains.js";

const DKIM = "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCyLXusGIambISQtEIPxOvVFzSm183Z752bTzIe+Hv4IcpbjKbdQPDXUgLaVwHGxZbcO6bKXL4K1clfaCVMBY8seHVM7Ne/rkJ1rkhiThKS/xFxeYkJTovhl+rZn4r9H/nERBmZ4JGPPvt0weOU1RgJmCYqe2aY17J8XaRdloYIQwIDAQAB";

/** The five records Resend returns for a domain with sending + receiving (names relative to the zone root). */
export function sampleRecords(domain: string, region: string, status = "not_started"): ResendDomainRecord[] {
  const zone = registrableDomain(domain);
  const sub = domain === zone ? "" : domain.slice(0, domain.length - zone.length - 1);
  const h = (base: string) => (sub ? (base ? `${base}.${sub}` : sub) : base || "@");
  const sesRegion = region === "ap-northeast-1" ? "ap-northeast-1" : region;
  return [
    { record: "DKIM", name: h("resend._domainkey"), type: "TXT", ttl: "Auto", status, value: DKIM },
    { record: "SPF", name: h("send"), type: "MX", ttl: "Auto", status, value: `feedback-smtp.${sesRegion}.amazonses.com`, priority: 10 },
    { record: "SPF", name: h("send"), type: "TXT", ttl: "Auto", status, value: "v=spf1 include:amazonses.com ~all" },
    { record: "SPF", name: h("rsend"), type: "CNAME", ttl: "Auto", status, value: "send.forge.rmta.net" },
    { record: "Receiving", name: h(""), type: "MX", ttl: "Auto", status, value: "receive-apne1.forge.rmta.net", priority: 10 },
  ];
}

export interface FakeResendDomains extends ResendDomainsPort {
  readonly store: Map<string, ResendDomain>;
  readonly calls: Array<{ op: string; arg?: unknown }>;
  /** Free slots: creating beyond this answers 403 like Resend's plan limit. Default 3. */
  limit: number;
  /** Make the next call of `op` fail with this error. */
  failNext(op: "create" | "get" | "verify" | "delete" | "list", e: ResendDomainError): void;
  /** Set the domain status (and every record's status). */
  setStatus(id: string, status: string): void;
  /** Add a domain that already exists in the "account". */
  seed(name: string, region?: string): ResendDomain;
}

export function createFakeResendDomains(): FakeResendDomains {
  const store = new Map<string, ResendDomain>();
  const calls: Array<{ op: string; arg?: unknown }> = [];
  const fails = new Map<string, ResendDomainError[]>();
  let n = 0;
  const take = (op: string) => {
    const q = fails.get(op);
    const e = q?.shift();
    if (e) throw e;
  };
  const clone = (d: ResendDomain): ResendDomain => structuredClone(d);
  const make = (name: string, region: string): ResendDomain => {
    n += 1;
    const d: ResendDomain = { id: `fake-domain-${n}`, name, status: "not_started", region, records: sampleRecords(name, region) };
    store.set(d.id, d);
    return d;
  };
  const api: FakeResendDomains = {
    store,
    calls,
    limit: 3,
    failNext(op, e) {
      fails.set(op, [...(fails.get(op) ?? []), e]);
    },
    setStatus(id, status) {
      const d = store.get(id);
      if (!d) throw new Error("unknown fake domain");
      d.status = status;
      d.records = d.records.map((r) => ({ ...r, status }));
    },
    seed: (name, region = "ap-northeast-1") => make(name, region),
    async listDomains() {
      calls.push({ op: "list" });
      take("list");
      return [...store.values()].map(({ records: _r, ...d }) => ({ ...d }));
    },
    async getDomain(id) {
      calls.push({ op: "get", arg: id });
      take("get");
      const d = store.get(id);
      if (!d) throw new ResendDomainError(404, "not_found", "Domain not found");
      return clone(d);
    },
    async createDomain(name: string, region: ResendRegion) {
      calls.push({ op: "create", arg: { name, region } });
      take("create");
      if (store.size >= api.limit) throw new ResendDomainError(403, "validation_error", "You have reached the limit of domains for your plan");
      if ([...store.values()].some((d) => d.name === name)) throw new ResendDomainError(403, "validation_error", "The domain has been registered already");
      return clone(make(name, region));
    },
    async verifyDomain(id) {
      calls.push({ op: "verify", arg: id });
      take("verify");
      const d = store.get(id);
      if (!d) throw new ResendDomainError(404, "not_found", "Domain not found");
      if (d.status === "not_started") api.setStatus(id, "pending");
    },
    async deleteDomain(id) {
      calls.push({ op: "delete", arg: id });
      take("delete");
      if (!store.delete(id)) throw new ResendDomainError(404, "not_found", "Domain not found");
    },
  };
  return api;
}

export interface FakeDns extends DnsResolver {
  /** Replace the answers for a name and type (strings as the resolver normalizes them). */
  set(name: string, type: DnsQueryType, answers: string[]): void;
  /** Names whose lookups fail (answer null). */
  failing: Set<string>;
  /** Publish a set of Resend records into the fake DNS. */
  publish(domain: string, records: ResendDomainRecord[]): void;
  readonly queries: Array<{ name: string; type: DnsQueryType }>;
}

export function createFakeDns(): FakeDns {
  const data = new Map<string, string[]>();
  const queries: Array<{ name: string; type: DnsQueryType }> = [];
  const failing = new Set<string>();
  const dns: FakeDns = {
    queries,
    failing,
    set: (name, type, answers) => void data.set(`${type}|${name.toLowerCase()}`, answers),
    async query(name, type) {
      queries.push({ name, type });
      if (failing.has(name.toLowerCase())) return null;
      return data.get(`${type}|${name.toLowerCase()}`) ?? [];
    },
    publish(domain, records) {
      const zone = registrableDomain(domain);
      for (const r of records) {
        const host = zoneRelativeHost(domain, zone, r.name);
        const fqdn = recordFqdn(host, zone);
        const key = `${r.type.toUpperCase()}|${fqdn}`;
        const value = r.type.toUpperCase() === "MX" ? `${r.priority ?? 10} ${r.value}` : r.value.replace(/^"(.*)"$/, "$1");
        data.set(key, [...(data.get(key) ?? []), value]);
      }
    },
  };
  return dns;
}
