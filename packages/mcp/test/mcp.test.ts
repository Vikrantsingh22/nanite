import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient } from "../src/client.js";
import { createNaniteMcpServer } from "../src/server.js";

const TOKEN = "nan_" + "A".repeat(43);

async function connect(handler: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; auth: string | null; method: string; body: unknown }[] = [];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, auth: new Headers(init?.headers).get("authorization"), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return handler(url, init ?? {});
  }) as typeof fetch;
  const server = createNaniteMcpServer(createClient({ apiUrl: "http://api.test/", token: TOKEN, fetch: fetchMock }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, calls };
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

describe("nanite MCP wrapper (hosted mode)", () => {
  it("extend_email posts {days} to /v1/emails/:key/extend with the token; refusals come back as isError", async () => {
    const key = "0x" + "ef".repeat(32);
    const { client, calls } = await connect((url) =>
      url.searchParams.has("deny")
        ? Response.json({ error: "x" }, { status: 409 })
        : Response.json({ status: "extended", expiresAtBlock: "99", expiresAt: "2030-01-01T00:00:00.000Z" }),
    );
    const r = await client.callTool({ name: "extend_email", arguments: { entityKey: key, days: 30 } });
    expect(JSON.parse(text(r))).toMatchObject({ status: "extended", expiresAtBlock: "99" });
    expect(calls[0]).toMatchObject({ method: "POST", auth: `Bearer ${TOKEN}`, body: { days: 30 } });
    expect(calls[0]!.url.pathname).toBe(`/v1/emails/${key}/extend`);
    // schema bounds are enforced before any request is made
    await expect(client.callTool({ name: "extend_email", arguments: { entityKey: key, days: 183 } })).resolves.toMatchObject({ isError: true });
    await expect(client.callTool({ name: "extend_email", arguments: { entityKey: "nope", days: 7 } })).resolves.toMatchObject({ isError: true });
    expect(calls).toHaveLength(1);
  });

  it("maps extend refusals (otp_not_extendable, extend_disabled, extend_limit) to isError with the code", async () => {
    const key = "0x" + "ef".repeat(32);
    for (const [status, error] of [[409, "otp_not_extendable"], [403, "extend_disabled"], [429, "extend_limit"]] as const) {
      const { client } = await connect(() => Response.json({ error }, { status }));
      const r = await client.callTool({ name: "extend_email", arguments: { entityKey: key, days: 7 } });
      expect(r.isError).toBe(true);
      expect(JSON.parse(text(r))).toEqual({ error, status });
    }
  });

  it("whoami returns email, ensName and custody from GET /v1/me", async () => {
    const { client, calls } = await connect(() => Response.json({ ensName: "bot.nanitecom.eth", email: "bot@mail.nanite.test", custody: "nanite", keyId: "k1" }));
    const r = await client.callTool({ name: "whoami", arguments: {} });
    expect(JSON.parse(text(r))).toEqual({ email: "bot@mail.nanite.test", ensName: "bot.nanitecom.eth", custody: "nanite" });
    expect(calls[0]!.url.pathname).toBe("/v1/me");
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("lists the seven tools and flags untrusted content in descriptions", async () => {
    const { client } = await connect(() => new Response("{}"));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["extend_email", "get_email", "get_latest_otp", "list_inbox", "send_email", "wait_for_email", "whoami"]);
    expect(tools.find((t) => t.name === "extend_email")!.description).toMatch(/only mail the user would want to keep/i);
    for (const n of ["get_email", "get_latest_otp", "wait_for_email"]) {
      expect(tools.find((t) => t.name === n)!.description).toMatch(/UNTRUSTED/);
    }
  });

  it("get_latest_otp calls the API with the bearer token and marks output untrusted", async () => {
    const { client, calls } = await connect(
      () => Response.json({ otp: "123456", receivedAt: 1, expiresAtBlock: "9", entityKey: "0x" + "ab".repeat(32) }),
    );
    const r = await client.callTool({ name: "get_latest_otp", arguments: {} });
    const body = JSON.parse(text(r));
    expect(body.otp).toBe("123456");
    expect(body.content_trust).toBe("untrusted");
    expect(calls[0]!.url.pathname).toBe("/v1/otp/latest");
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("send_email posts {to, subject, body, inReplyTo} to /v1/emails/send with the token", async () => {
    const key = "0x" + "cd".repeat(32);
    const { client, calls } = await connect(() => Response.json({ status: "sent", providerMessageId: "p1", entityKey: null, signature: "signed" }));
    const r = await client.callTool({ name: "send_email", arguments: { to: "a@b.co", subject: "Hi", body: "Yo", inReplyTo: key } });
    expect(JSON.parse(text(r)).status).toBe("sent");
    expect(calls[0]).toMatchObject({ method: "POST", auth: `Bearer ${TOKEN}`, body: { to: "a@b.co", subject: "Hi", body: "Yo", inReplyTo: key } });
    expect(calls[0]!.url.pathname).toBe("/v1/emails/send");
  });

  it("send_email maps policy errors to isError", async () => {
    const { client } = await connect(() => Response.json({ error: "policy_reply_only" }, { status: 403 }));
    const r = await client.callTool({ name: "send_email", arguments: { to: "a@b.co", subject: "Hi", body: "Yo" } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r))).toEqual({ error: "policy_reply_only", status: 403 });
  });

  it("maps API errors to isError without leaking the token, and 204 to timeout", async () => {
    const { client } = await connect((url) =>
      url.pathname.endsWith("/wait") ? new Response(null, { status: 204 }) : Response.json({ error: "not_found" }, { status: 404 }),
    );
    const e = await client.callTool({ name: "get_latest_otp", arguments: {} });
    expect(e.isError).toBe(true);
    expect(text(e)).not.toContain(TOKEN);
    const w = await client.callTool({ name: "wait_for_email", arguments: { type: "otp", timeout: 1 } });
    expect(JSON.parse(text(w)).status).toBe("timeout");
  });
});
