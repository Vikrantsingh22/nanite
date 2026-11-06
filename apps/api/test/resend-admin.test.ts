import { describe, expect, it } from "vitest";
import { sharedMailDomainWarning } from "../src/env.js";
import {
  ResendAdminError,
  buildCreateDomainBody,
  createResendAdmin,
  fqdn,
  parentZone,
  recordRows,
  renderConsole,
  renderMarkdown,
  type DomainInfo,
} from "../scripts/lib/resend-admin.js";

const KEY = "re_SECRET_KEY_VALUE";
const DKIM = "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCyLXusGIambISQtEIPxOvVFzSm183Z752bTzIe+Hv4IcpbjKbdQPDXUgLaVwHGxZbcO6bKXL4K1clfaCVMBY8seHVM7Ne/rkJ1rkhiThKS/xFxeYkJTovhl+rZn4r9H/nERBmZ4JGPPvt0weOU1RgJmCYqe2aY17J8XaRdloYIQwIDAQAB";

const domain = (over: Partial<DomainInfo> = {}): DomainInfo => ({
  id: "610a155e-009e-4433-b0bb-d62b8d4691ec",
  name: "nanitecom.itsvikrant.tech",
  status: "not_started",
  region: "ap-northeast-1",
  capabilities: { sending: "enabled", receiving: "enabled" },
  records: [
    { record: "DKIM", name: "resend._domainkey.nanitecom", type: "TXT", ttl: "Auto", status: "not_started", value: DKIM },
    { record: "SPF", name: "send.nanitecom", type: "MX", ttl: "Auto", status: "not_started", value: "feedback-smtp.ap-northeast-1.amazonses.com", priority: 10 },
    { record: "SPF", name: "send.nanitecom", type: "TXT", ttl: "Auto", status: "not_started", value: "v=spf1 include:amazonses.com ~all" },
    { record: "SPF", name: "rsend.nanitecom", type: "CNAME", ttl: "Auto", status: "not_started", value: "send.forge.rmta.net" },
    { record: "Receiving", name: "nanitecom", type: "MX", ttl: "Auto", status: "not_started", value: "receive-apne1.forge.rmta.net", priority: 10 },
  ],
  ...over,
});

/** A tiny stateful Resend: GET/POST /domains, GET /domains/:id, POST /domains/:id/verify. */
function fakeResend(initial: DomainInfo[] = []) {
  const store = [...initial];
  const calls: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
    const method = init.method ?? "GET";
    calls.push({ method, path, auth: new Headers(init.headers).get("authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (method === "GET" && path === "/domains") return json({ object: "list", has_more: false, data: store.map(({ records: _r, ...d }) => d) });
    if (method === "POST" && path === "/domains") {
      const body = JSON.parse(String(init.body));
      const d = domain({ id: `id-${store.length + 1}`, name: body.name, region: body.region });
      store.push(d);
      return json(d, 201);
    }
    const m = /^\/domains\/([^/]+)(\/verify)?$/.exec(path);
    const found = m && store.find((d) => d.id === m[1]);
    if (!found) return json({ statusCode: 404, name: "not_found", message: "no" }, 404);
    if (method === "POST" && m![2]) return json({ object: "domain", id: found.id });
    return json(found);
  }) as typeof fetch;
  return { f, calls, store };
}

describe("SHARED_MAIL_DOMAIN startup warning (G9)", () => {
  it("warns only for real Resend with the nanite.test placeholder", () => {
    expect(sharedMailDomainWarning({ RESEND_API_KEY: "re_x" })).toContain("SHARED_MAIL_DOMAIN");
    expect(sharedMailDomainWarning({ RESEND_API_KEY: "re_x", SHARED_MAIL_DOMAIN: "nanite.test" })).not.toBeNull();
    expect(sharedMailDomainWarning({ RESEND_API_KEY: "re_x", SHARED_MAIL_DOMAIN: "mail.example.com" })).toBeNull();
    expect(sharedMailDomainWarning({ SHARED_MAIL_DOMAIN: "nanite.test" })).toBeNull();
    expect(sharedMailDomainWarning({ RESEND_API_KEY: "re_x", FAKE_RESEND_CONTENT: "1" })).toBeNull();
    expect(sharedMailDomainWarning({ RESEND_API_KEY: "re_x" })).not.toContain("re_x");
  });
});

describe("resend domain admin (fake fetch)", () => {
  it("builds the documented create body: sending + receiving, no tracking, opportunistic TLS, no tracking_subdomain", () => {
    expect(buildCreateDomainBody("mail.example.com", "eu-west-1")).toEqual({
      name: "mail.example.com",
      region: "eu-west-1",
      capabilities: { sending: "enabled", receiving: "enabled" },
      open_tracking: false,
      click_tracking: false,
      tls: "opportunistic",
    });
    expect(Object.keys(buildCreateDomainBody("a.b.c", "us-east-1"))).not.toContain("tracking_subdomain");
    expect(Object.keys(buildCreateDomainBody("a.b.c", "us-east-1"))).not.toContain("custom_return_path");
  });

  it("is idempotent: an existing domain is fetched, never created again; a missing one is created exactly once", async () => {
    const existing = fakeResend([domain()]);
    const a = await createResendAdmin(KEY, existing.f).ensureDomain("NaniteCom.itsvikrant.tech", "ap-northeast-1");
    expect(a.created).toBe(false);
    expect(a.domain.records).toHaveLength(5);
    expect(existing.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /domains", "GET /domains/610a155e-009e-4433-b0bb-d62b8d4691ec"]);

    const empty = fakeResend();
    const admin = createResendAdmin(KEY, empty.f);
    const first = await admin.ensureDomain("mail.example.com", "eu-west-1");
    expect(first.created).toBe(true);
    const post = empty.calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/domains");
    expect(post.body).toEqual(buildCreateDomainBody("mail.example.com", "eu-west-1"));
    const second = await admin.ensureDomain("mail.example.com", "eu-west-1");
    expect(second.created).toBe(false);
    expect(empty.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(empty.store).toHaveLength(1);
    expect(empty.calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);
  });

  it("verify posts to /domains/{id}/verify; errors carry status and name only, never the key", async () => {
    const r = fakeResend([domain()]);
    const admin = createResendAdmin(KEY, r.f);
    expect(await admin.verifyDomain(domain().id)).toEqual({ object: "domain", id: domain().id });
    expect(r.calls.at(-1)).toMatchObject({ method: "POST", path: `/domains/${domain().id}/verify` });
    const err = (await admin.getDomain("missing").catch((e) => e)) as ResendAdminError;
    expect(err).toBeInstanceOf(ResendAdminError);
    expect(err.message).toBe("Resend GET /domains/missing answered 404 not_found");
    expect(err.message).not.toContain(KEY);
    expect(await admin.findDomain("other.example.com")).toBeNull();
  });

  it("moves the single webhook to a new https endpoint, keeps events, prints no secret", async () => {
    const hook = { id: "wh_1", endpoint: "https://old.trycloudflare.com/webhooks/resend", events: ["email.received", "domain.updated"], signing_secret: "whsec_TOPSECRET" };
    const calls: { method: string; path: string; body: unknown }[] = [];
    const f = (async (url: string | URL, init: RequestInit = {}) => {
      const path = new URL(String(url)).pathname;
      const method = init.method ?? "GET";
      calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET" && path === "/webhooks") return new Response(JSON.stringify({ data: [{ id: hook.id, endpoint: hook.endpoint, events: hook.events }] }));
      if (method === "PATCH" && path === "/webhooks/wh_1") {
        hook.endpoint = (JSON.parse(String(init.body)) as { endpoint: string }).endpoint;
        return new Response(JSON.stringify({ id: hook.id }));
      }
      if (method === "GET" && path === "/webhooks/wh_1") return new Response(JSON.stringify(hook));
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const admin = createResendAdmin(KEY, f);
    const out = await admin.setWebhookEndpoint("https://api.nanite.itsvikrant.tech/webhooks/resend");
    expect(out).toEqual({ endpoint: "https://api.nanite.itsvikrant.tech/webhooks/resend", events: ["email.received", "domain.updated"] });
    expect(JSON.stringify(out)).not.toContain("whsec_");
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ endpoint: "https://api.nanite.itsvikrant.tech/webhooks/resend" });
    await expect(admin.setWebhookEndpoint("http://insecure.example.com/x")).rejects.toThrow("https");
    await expect(admin.setWebhookEndpoint("not a url")).rejects.toThrow("absolute");
    const none = createResendAdmin(KEY, (async () => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch);
    await expect(none.setWebhookEndpoint("https://a.example.com/x")).rejects.toThrow("found 0");
  });

  it("maps record names under the parent zone to full names, with MX priority and the untruncated value", () => {
    const d = domain();
    expect(parentZone(d.name, d.records)).toBe("itsvikrant.tech");
    expect(parentZone("example.com", [{ name: "send" }, { name: "resend._domainkey" }])).toBe("example.com");
    expect(fqdn("send.nanitecom", "itsvikrant.tech")).toBe("send.nanitecom.itsvikrant.tech");
    expect(fqdn("@", "example.com")).toBe("example.com");

    const { rows } = recordRows(d);
    expect(rows.find((r) => r.purpose === "Receiving")).toMatchObject({ type: "MX", host: "nanitecom", fqdn: "nanitecom.itsvikrant.tech", priority: "10", value: "receive-apne1.forge.rmta.net" });
    expect(rows.find((r) => r.type === "CNAME")).toMatchObject({ host: "rsend.nanitecom", fqdn: "rsend.nanitecom.itsvikrant.tech", value: "send.forge.rmta.net" });
    expect(rows.at(-1)).toMatchObject({ type: "TXT", host: "_dmarc.nanitecom", fqdn: "_dmarc.nanitecom.itsvikrant.tech" });

    const md = renderMarkdown(d, "2026-11-06");
    expect(md).toContain(DKIM); // full value
    expect(md).toContain("| 5 | Receiving | MX | `nanitecom` | nanitecom.itsvikrant.tech | `receive-apne1.forge.rmta.net` | 10 | not_started |");
    expect(md).toContain("zone of `itsvikrant.tech`");
    expect(renderConsole(d)).toContain(DKIM);
    expect(md + renderConsole(d)).not.toContain(KEY);
  });
});
