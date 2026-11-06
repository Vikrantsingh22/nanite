/*
 * T3.7 live check, part 2: a real mail reached the self-custody agent `kit`. Read it through the MCP kit in LOCAL mode
 * (stdio, MCP SDK client), reply with ONE self-signed send, verify the signature against live ENS, ask Resend.
 * Prints booleans, ids, hashes and header names only. Never prints email content, tokens or keys.
 *
 *   docker compose run --rm -v "$PWD/apps/api/.live-selfhosted:/keys" -e API_URL=http://nanite-api-live:4000 tools \
 *     npx tsx apps/api/scripts/live-selfhosted-part2.ts
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createSepoliaNameReader, verifyNaniteSignature } from "@nanite/ens";
import { privateKeyToAccount } from "viem/accounts";
import { ApiClient, entityLink, loadLiveEnv, rawQueryByKey, userAccount } from "./lib/live.js";

const SENDER = "vikrantsingh202004@gmail.com";
const ENS = "kit.nanitedemo.nanitecom.eth";
const MAILBOX = "kit.nanitedemo@nanitecom.itsvikrant.tech";
const env = loadLiveEnv();
const api = new ApiClient(env.apiUrl, env.webOrigin);
const say = (l: string) => console.log(l);
const token = readFileSync("/keys/token", "utf8").trim();

try {
  // 1a. server side: list (metadata), single email without raw -> 409, with raw -> envelope only
  const list = await api.get("/v1/inbox?limit=20", { token });
  const items = (list.json?.items ?? []) as Array<{ entityKey: string; type: string; receivedAt: number }>;
  say(`[1] GET /v1/inbox -> ${list.status}, ${items.length} item(s), types ${items.map((i) => i.type).join(",")}`);
  const target = items.filter((i) => i.type !== "sent").sort((a, b) => b.receivedAt - a.receivedAt)[0];
  if (!target) throw new Error("no inbound entity in the inbox");
  const key = target.entityKey;
  say(`    entity ${key} type=${target.type}`);
  const plain409 = await api.get(`/v1/emails/${key}`, { token });
  say(`    GET /v1/emails/<key> (no raw) -> ${plain409.status} ${plain409.json?.error ?? ""}`);
  const rawRes = await api.get(`/v1/emails/${key}?raw=1`, { token });
  const rawKeys = Object.keys(rawRes.json ?? {});
  const rawText = JSON.stringify(rawRes.json ?? {});
  say(`    GET ?raw=1 -> ${rawRes.status}; fields: ${rawKeys.join(",")}; has subject/body/untrusted fields: ${["subject", "body", "untrusted", "text"].some((k) => rawKeys.includes(k))}`);

  // 2. local-mode MCP over stdio
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["packages/mcp/bin/nanite-mcp.mjs"],
    env: {
      PATH: process.env.PATH ?? "",
      NODE_OPTIONS: "--import /keys/capture.mjs", // the launcher spawns a child: only NODE_OPTIONS reaches it
      NANITE_API_URL: env.apiUrl,
      NANITE_AGENT_TOKEN: token,
      NANITE_AGENT_KEY_FILE: "/keys/agent-key.json",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "live-check", version: "0.0.1" });
  // kit stderr is safe by design (fixed messages, never key material); show the first lines only
  transport.stderr?.on("data", (d: Buffer) => console.log(`    [kit stderr] ${d.toString().slice(0, 200).trim()}`));
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  say(`[2] MCP local mode connected; tools: ${tools.join(",")}`);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    return { isError: !!r.isError, json };
  };

  const li = await call("list_inbox", { limit: 20 });
  say(`    list_inbox: error=${li.isError}; ${li.json?.items?.length ?? 0} item(s); has entity=${li.json?.items?.some((i: any) => i.entityKey === key)}; fields ${Object.keys(li.json?.items?.[0] ?? {}).join(",")}`);
  const ge = await call("get_email", { entityKey: key });
  const u = ge.json?.untrusted;
  const subject: string = u?.subject ?? "";
  const body: string = u?.body ?? "";
  say(`    get_email: error=${ge.isError}; decrypted locally=${subject.length > 0 || body.length > 0}; subject present=${subject.length > 0} (len ${subject.length}); body present=${body.length > 0} (len ${body.length}); content_trust=${ge.json?.content_trust}; under untrusted=${!!u}; otp detected=${!!ge.json?.otp}; links=${ge.json?.links?.length ?? 0}`);
  const ot = await call("get_latest_otp");
  say(`    get_latest_otp: error=${ot.isError}; otp present=${!!ot.json?.otp}; same entity=${ot.json?.entityKey === key}; content_trust=${ot.json?.content_trust}; matches get_email otp=${!!ot.json?.otp && ot.json?.otp === ge.json?.otp}`);
  if (!subject) throw new Error("local decrypt failed");

  // 1b. server response held no plaintext (compare in memory)
  const hay = (rawText + JSON.stringify(plain409.json ?? {}) + JSON.stringify(list.json ?? {})).toLowerCase();
  say(`    server responses contain subject: ${hay.includes(subject.toLowerCase())}; contain sender address: ${hay.includes(SENDER)}`);

  // 2b. raw Arkiv entity
  const arkivOp = privateKeyToAccount(env.arkivOperatorKey!).address;
  const q = await rawQueryByKey(env.arkivRpc, key, arkivOp);
  const e0 = q.entities[0];
  const lower = q.raw.toLowerCase();
  say(`    raw arkiv: entities=${q.entities.length} owner===user ${e0?.owner === userAccount(env).address.toLowerCase()} creator===operator ${e0?.creator === arkivOp.toLowerCase()} needle subject ${lower.includes(subject.toLowerCase())} needle from ${lower.includes(SENDER)}`);
  say(`    explorer ${entityLink(key)}`);

  // 3. exactly one self-signed send
  const reply = `Re: ${subject}`;
  const text = "Hello from your self-hosted Nanite agent kit.nanitedemo.nanitecom.eth. Your email was decrypted only on this agent's machine, and this reply is signed with the agent's own key published at nanite.signer.";
  const sent = await call("send_email", { to: SENDER, subject: reply, body: text, inReplyTo: key });
  say(`[3] send_email: isError=${sent.isError}; result keys ${Object.keys(sent.json ?? {}).join(",")}`);
  if (sent.isError) {
    say(`    error ${JSON.stringify(sent.json)}`);
    await client.close();
    process.exit(1);
  }
  const pid: string = sent.json.providerMessageId;
  say(`    status ${sent.json.status ?? "-"}; providerMessageId ${pid}; entityKey ${sent.json.entityKey}; signature ${sent.json.signature}; threading ${sent.json.threading ?? "ok"}; sentCopy ${sent.json.sentCopy ?? "-"}`);
  await client.close();

  // 4. verify what the kit sent against live ENS
  const req = JSON.parse(readFileSync("/keys/sendreq.json", "utf8")) as { naniteMessageId: string; date: string; signature: string; to: string; subject: string; body: string };
  const headers = {
    "X-Nanite-Agent": ENS,
    "X-Nanite-Date": req.date,
    "X-Nanite-Signature": req.signature,
    "X-Nanite-Sig-Version": "3",
    "X-Nanite-Message-Id": req.naniteMessageId,
  };
  const v = await verifyNaniteSignature({ headers, from: MAILBOX, to: req.to, subject: req.subject, body: req.body }, { ensClient: createSepoliaNameReader(env.sepoliaRpc) });
  say(`[4] verifyNaniteSignature (v3, live ENS, kit's own header values): ${JSON.stringify(v)}`);
  let last: string | undefined;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`https://api.resend.com/emails/${pid}`, { headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
    if (res.status === 200) { last = ((await res.json()) as { last_event?: string }).last_event; break; }
    await new Promise((x) => setTimeout(x, 3000));
  }
  say(`    Resend GET /emails/<id> last_event=${last ?? "unavailable"}`);
  process.exit(0);
} catch (e) {
  console.error(`failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
  process.exit(1);
}
