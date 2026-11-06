/*
 * In-memory fake of the custom-domain endpoints of the Nanite API (T3.6), shared by the e2e specs.
 * `stage` is driven by the tests: 0 nothing in DNS, 1 two TXT records found, 2 everything found (Resend pending),
 * 3 verified.
 */

export type DomainStage = 0 | 1 | 2 | 3;

export interface DomainMockState {
  exists: boolean;
  name: string;
  stage: DomainStage;
  /** GET /onboarding/domain calls. */
  polls: number;
  verifyCalls: number;
  checkCalls: number;
  createBody: Record<string, unknown> | null;
  /** When true, POST verify answers 429. */
  limited: boolean;
}

export const newDomainState = (): DomainMockState => ({ exists: false, name: "", stage: 0, polls: 0, verifyCalls: 0, checkCalls: 0, createBody: null, limited: false });

const DKIM = "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCyLXusGIambISQtEIPxOvVFzSm183Z752bTzIe+Hv4IcpbjKbdQPDXUgLaVwHGxZbcO6bKXL4K1clfaCVMBY8seHVM7Ne/rkJ1rkhiThKS/xFxeYkJTovhl+rZn4r9H/nERBmZ4JGPPvt0weOU1RgJmCYqe2aY17J8XaRdloYIQwIDAQAB";

export const domainSummary = (s: DomainMockState) => (s.exists ? { name: s.name, status: s.stage === 3 ? "verified" : s.stage === 2 ? "pending" : "not_started" } : null);

function view(s: DomainMockState) {
  const root = s.name.split(".").slice(-2).join(".");
  const sub = s.name === root ? "" : s.name.slice(0, s.name.length - root.length - 1);
  const h = (base: string) => (sub ? (base ? `${base}.${sub}` : sub) : base || "@");
  const rec = (purpose: string, type: string, host: string, value: string, found: boolean, priority?: number) => ({
    purpose,
    type,
    host,
    fqdn: host === "@" ? root : `${host}.${root}`,
    value,
    ...(priority !== undefined ? { priority } : {}),
    resendStatus: s.stage === 3 ? "verified" : s.stage === 2 ? "pending" : "not_started",
    dnsFound: s.stage === 0 ? false : found,
  });
  const all = s.stage >= 2;
  return {
    name: s.name,
    zone: root,
    status: domainSummary(s)!.status,
    region: "ap-northeast-1",
    records: [
      rec("DKIM", "TXT", h("resend._domainkey"), DKIM, s.stage >= 1),
      rec("SPF bounce MX", "MX", h("send"), "feedback-smtp.ap-northeast-1.amazonses.com", all, 10),
      rec("SPF", "TXT", h("send"), "v=spf1 include:amazonses.com ~all", s.stage >= 1),
      rec("SPF CNAME", "CNAME", h("rsend"), "send.forge.rmta.net", all),
      rec("Receiving", "MX", h(""), "receive-apne1.forge.rmta.net", all, 10),
    ],
    provider: "cloudflare",
    providerTips: [
      'Cloudflare: set the CNAME record to "DNS only" (grey cloud). A proxied (orange cloud) CNAME will not verify.',
      "Cloudflare: use priority 10 for MX records, and enter the host only (Cloudflare appends your domain).",
    ],
    lastCheckedAt: new Date().toISOString(),
    nextCheckAt: s.stage === 3 ? null : new Date(Date.now() + 15000).toISOString(),
    verifyAvailableAt: null,
    verifiedAt: s.stage === 3 ? new Date().toISOString() : null,
  };
}

/** Returns a response for a domain endpoint, or null when the path is not one of them. */
export function handleDomain(s: DomainMockState, path: string, method: string, body: unknown): { status: number; body: unknown; headers?: Record<string, string> } | null {
  if (path === "/onboarding/domain/check" && method === "POST") {
    s.checkCalls++;
    const name = String((body as { name?: string }).name ?? "").toLowerCase();
    if (name === "taken.com") return { status: 409, body: { error: "domain_taken", message: "That domain is already used by another account." } };
    const apex = name.split(".").length === 2;
    return {
      status: 200,
      body: {
        name,
        root: name.split(".").slice(-2).join("."),
        ...(apex ? { suggestion: `mail.${name}` } : {}),
        rootHasMx: apex,
        provider: "cloudflare",
        warnings: apex ? [`${name} already receives mail (it has MX records). Adding Nanite's MX record there would replace it and break your current mailboxes. Use mail.${name} instead.`] : [],
      },
    };
  }
  if (path === "/onboarding/domain" && method === "POST") {
    s.createBody = body as Record<string, unknown>;
    s.exists = true;
    s.name = String((body as { name?: string }).name);
    s.stage = 0;
    return { status: 201, body: view(s) };
  }
  if (path === "/onboarding/domain" && method === "GET") {
    s.polls++;
    return s.exists ? { status: 200, body: view(s) } : { status: 404, body: { error: "no_domain" } };
  }
  if (path === "/onboarding/domain" && method === "DELETE") {
    s.exists = false;
    return { status: 200, body: { ok: true } };
  }
  if (path === "/onboarding/domain/verify" && method === "POST") {
    s.verifyCalls++;
    if (s.limited) return { status: 429, body: { error: "verify_rate_limited", retryAfterSeconds: 20 }, headers: { "retry-after": "20" } };
    return { status: 200, body: view(s) };
  }
  return null;
}
