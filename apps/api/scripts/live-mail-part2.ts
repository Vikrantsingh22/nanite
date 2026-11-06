/*
 * First real-email test, part 2. Prints booleans, ids, hashes and header NAMES only (never content, tokens or keys).
 * Sends exactly ONE real mail (the reply) when step 3 is reached.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  ApiClient, decryptAll, ensureKeys, entityLink, listInbox, loadLiveEnv, rawQueryByKey, siweLogin, userAccount,
} from "./lib/live.js";

const AGENT_ID = "d486fd54-a2a1-4566-8768-ec4843742a35";
const SENDER = "vikrantsingh202004@gmail.com";
const env = loadLiveEnv();
const api = new ApiClient(env.apiUrl, env.webOrigin);
const say = (l: string) => console.log(l);
const token = readFileSync("apps/api/.live-agent-token", "utf8").trim();

try {
  const account = userAccount(env);
  const me = await siweLogin(api, account, env.webOrigin);
  const { keys } = await ensureKeys(api, account, me);
  const dec = await decryptAll(await listInbox(api, AGENT_ID), keys);
  const real = dec.filter((d) => d.mail?.meta?.from === SENDER && d.entity.type !== "sent");
  say(`inbox: ${dec.length} entities, ${real.length} from the real sender`);
  const hit = real.sort((a, b) => b.entity.receivedAt - a.entity.receivedAt)[0];
  if (!hit?.mail) throw new Error("no decryptable entity from the real sender");
  const { entity, mail } = hit;
  say(`[1] entity ${entity.key} type=${entity.type}`);
  say(`    subject present=${mail.subject.length > 0} (len ${mail.subject.length}); body present=${mail.body.length > 0} (len ${mail.body.length})`);
  say(`    meta.from === sender: ${mail.meta?.from === SENDER}; messageId present=${!!mail.meta?.messageId}; otp detected=${!!mail.meta?.otp}; links=${mail.meta?.links?.length ?? 0}`);
  const arkivOp = privateKeyToAccount(env.arkivOperatorKey!).address;
  const q = await rawQueryByKey(env.arkivRpc, entity.key, arkivOp);
  const e0 = q.entities[0];
  const lower = q.raw.toLowerCase();
  say(`    raw arkiv: entities=${q.entities.length} owner===user ${e0?.owner === account.address.toLowerCase()} creator===operator ${e0?.creator === arkivOp.toLowerCase()} needle subject ${lower.includes(mail.subject.toLowerCase())} needle from ${lower.includes(SENDER)}`);
  say(`    explorer ${entityLink(entity.key)}`);

  // 2. agent API
  const ai = await api.get("/v1/inbox?limit=50", { token });
  const listed = ai.status === 200 && (ai.json.items as Array<{ entityKey: string }>).some((i) => i.entityKey === entity.key);
  const ae = await api.get(`/v1/emails/${entity.key}`, { token });
  const u = ae.json?.untrusted;
  say(`[2] /v1/inbox ${ai.status} lists entity=${listed}; /v1/emails ${ae.status} subject match=${u?.subject === mail.subject} body match=${u?.body === mail.body} otp present=${!!ae.json?.otp} content_trust=${ae.json?.content_trust}`);

  // 3. reply (exactly one send)
  const subject = `Re: ${mail.subject}`;
  const body = "Hello from your Nanite agent mail.nanitedemo.nanitecom.eth. This reply was sent through Resend, permitted by the agent's ENS send policy, and signed with the key published at nanite.signer.";
  const sent = await api.post("/v1/emails/send", { to: SENDER, subject, body, inReplyTo: entity.key }, { token });
  say(`[3] send HTTP ${sent.status}; keys: ${Object.keys(sent.json ?? {}).join(",")}`);
  if (sent.status !== 200) throw new Error(`send failed: ${sent.json?.error ?? ""} ${sent.json?.message ?? ""}`.slice(0, 200));
  const pid: string = sent.json.providerMessageId;
  say(`    providerMessageId ${pid}; entityKey ${sent.json.entityKey}; threading ${sent.json.threading}; signature ${sent.json.signature}; sentCopy ${sent.json.sentCopy ?? "-"}`);

  // 4. sent copy
  let sentCopy = null as null | { subjectOk: boolean; bodyOk: boolean; inReplyTo: boolean; to: boolean };
  for (let i = 0; i < 30 && !sentCopy; i++) {
    const d = (await decryptAll(await listInbox(api, AGENT_ID, "sent"), keys)).find((x) => x.entity.key === sent.json.entityKey);
    if (d?.mail) sentCopy = { subjectOk: d.mail.subject === subject, bodyOk: d.mail.body === body, inReplyTo: !!d.mail.meta?.inReplyTo, to: d.mail.meta?.to === SENDER };
    else await new Promise((r) => setTimeout(r, 3000));
  }
  say(`[4] sent copy in user inbox (type sent) decrypts: ${!!sentCopy} ${JSON.stringify(sentCopy)}`);

  // 5. what Resend recorded
  let r: any = null;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`https://api.resend.com/emails/${pid}`, { headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
    say(`[5] GET resend /emails/:id -> ${res.status}`);
    if (res.status === 200) { r = await res.json(); break; }
    await new Promise((x) => setTimeout(x, 3000));
  }
  if (r) {
    say(`    top-level keys: ${Object.keys(r).join(",")}; last_event=${r.last_event}`);
    const h = r.headers;
    say(`    headers field: ${h === undefined ? "absent" : Array.isArray(h) ? `array(${h.length})` : typeof h}`);
    const hm: Record<string, string> = {};
    if (Array.isArray(h)) for (const x of h) hm[x.name] = x.value;
    else if (h && typeof h === "object") Object.assign(hm, h);
    say(`    header names: ${Object.keys(hm).join(",") || "-"}`);
    if (hm["X-Nanite-Signature"]) {
      const fromAddr = String(r.from).match(/<([^>]+)>/)?.[1] ?? String(r.from);
      const to = Array.isArray(r.to) ? r.to[0] : r.to;
      const dir = mkdtempSync(join(tmpdir(), "nanite-sig-"));
      try {
        const file = join(dir, "mail.json");
        writeFileSync(file, JSON.stringify({ headers: hm, from: fromAddr, to, subject: r.subject ?? subject, body: r.text ?? body }));
        const v = spawnSync(process.execPath, ["--import", "tsx", "apps/api/scripts/verify-mail-signature.ts", file, `--rpc=${env.sepoliaRpc}`], { encoding: "utf8" });
        say(`    verify exit ${v.status}: ${(v.stdout ?? "").trim()}`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    } else say("    X-Nanite-* headers not available from Resend");
  }
  process.exit(0);
} catch (e) {
  console.error(`failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
  process.exit(1);
}
