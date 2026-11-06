/*
 * LIVE end-to-end run (T4.1 prep): drives the real HTTP API as the test user wallet, with real Sepolia (ENSv2)
 * and real Arkiv (Rabdi) writes. NO real email is sent: inbound uses the signed fake Resend webhook (the API
 * must run with FAKE_RESEND_CONTENT=1) and outbound uses the API's FAKE_RESEND_SEND=1 provider.
 *
 *   docker compose run --rm tools npx tsx apps/api/scripts/live-e2e.ts [--username=e2eabc12] [--api=http://api:4000]
 *
 * Needs in .env: TEST_USER_PRIVATE_KEY, SEPOLIA_RPC_URL, RESEND_WEBHOOK_SECRET (same as the API's),
 * OPERATOR_PRIVATE_KEY and ARKIV_OPERATOR_PRIVATE_KEY (only to derive addresses / read the balance).
 * Resumable: if the wallet already has a username (in the API's database) the run continues with it, reusing
 * existing keys (unlocked with the wallet signature), username and agent. A different username needs a fresh
 * database (see LIVE-E2E.md).
 *
 * Prints only step results, tx hashes, entity keys and addresses. Appends a run section to apps/api/LIVE-E2E.md.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { sendFakeWebhook } from "./lib/fake-webhook.js";
import {
  ApiClient,
  MIN_OPERATOR_ETH,
  arkivBlockNumber,
  decryptAll,
  ensureAgent,
  ensureKeys,
  ensureUsername,
  entityLink,
  listInbox,
  loadLiveEnv,
  operatorBalanceEth,
  rawQueryByKey,
  readOnlyEns,
  siweLogin,
  sleep,
  txLink,
  userAccount,
  waitFor,
  type AgentInfo,
  type MailEntity,
  type Step,
} from "./lib/live.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const env = loadLiveEnv({ ...process.env, ...(arg("api") ? { API_URL: arg("api") } : {}) });
const account = userAccount(env);
const api = new ApiClient(env.apiUrl, env.webOrigin);
const DOC = fileURLToPath(new URL("../LIVE-E2E.md", import.meta.url));

// ---- expected canned content (src/mail/fake.ts fixtures)
const CONV = { subject: "Quick question about the onboarding draft", from: "dana@whitfield-studio.example", bodyHas: "pricing table", link: "https://drive.whitfield-studio.example/onboarding" };
const OTP = { subject: "Your Acme verification code", from: "no-reply@acme-auth.example", code: "482913" };
const STRANGER = "stranger@nowhere.example";
const LEAK_NEEDLES = [CONV.subject, "onboarding draft", "pricing table", CONV.from, "whitfield", OTP.subject, OTP.from, "acme-auth", OTP.code, "Quick question"];

interface Rec {
  step: string;
  ok: boolean;
  ms: number;
  note: string;
}
const results: Rec[] = [];
const txs: Array<{ what: string; hash: string }> = [];
const entities: Array<{ what: string; key: string; tx?: string }> = [];
const failures: string[] = [];
const say = (l: string) => console.log(l);
const addTxs = (what: string, steps: Step[]) => {
  for (const s of steps) if (s.txHash) txs.push({ what: `${what}: ${s.id}`, hash: s.txHash });
};

async function step<T>(id: string, fn: () => Promise<{ note: string; value?: T }>): Promise<T | undefined> {
  const t0 = Date.now();
  say(`[${id}] ...`);
  try {
    const r = await fn();
    results.push({ step: id, ok: true, ms: Date.now() - t0, note: r.note });
    say(`[${id}] OK (${((Date.now() - t0) / 1000).toFixed(1)}s) ${r.note}`);
    return r.value;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    results.push({ step: id, ok: false, ms: Date.now() - t0, note: msg });
    failures.push(`${id}: ${msg}`);
    say(`[${id}] FAILED (${((Date.now() - t0) / 1000).toFixed(1)}s) ${msg}`);
    throw e;
  }
}
const must = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

const runStarted = new Date();
let username = "";
let agentInfo: AgentInfo | undefined;
let balanceStart: number | undefined;
let balanceEnd: number | undefined;
let operatorAddr = "";
let arkivOperator = "";
const otpInfo: { key?: string; expiresAtBlock?: number; goneAtBlock?: number; lastSeenBlock?: number; lastSeenAtMs?: number; goneAtMs?: number; writtenAtBlock?: number } = {};
const extra: string[] = [];

try {
  // ---- preflight
  await step("0 preflight", async () => {
    const h = await fetch(`${env.apiUrl}/health`).then((r) => r.json() as Promise<{ ok?: boolean }>);
    must(h.ok, "API /health not ok");
    const bal = await operatorBalanceEth(env);
    must(bal, "OPERATOR_PRIVATE_KEY missing: cannot check the gas balance");
    operatorAddr = bal!.address;
    balanceStart = bal!.eth;
    must(bal!.eth >= MIN_OPERATOR_ETH, `operator balance ${bal!.eth.toFixed(4)} ETH is below ${MIN_OPERATOR_ETH}: stop`);
    must(env.arkivOperatorKey, "ARKIV_OPERATOR_PRIVATE_KEY missing");
    arkivOperator = privateKeyToAccount(env.arkivOperatorKey!).address;
    return { note: `api up; ENS operator ${operatorAddr} has ${bal!.eth.toFixed(4)} ETH; arkiv operator ${arkivOperator}; user ${account.address}` };
  });

  // ---- a. SIWE
  const me = await step("a SIWE sign-in", async () => {
    const m = await siweLogin(api, account, env.webOrigin);
    must(m.wallet === account.address.toLowerCase(), "wallet mismatch");
    return { note: `session cookie set; onboardingState=${m.onboardingState} hasKeys=${m.hasKeys} username=${m.username ?? "-"}`, value: m };
  });
  username = me!.username ?? arg("username") ?? `e2e${Date.now().toString(36).slice(-5)}`;

  // ---- b. keys
  const keys = await step("b keys", async () => {
    const r = await ensureKeys(api, account, me!);
    return { note: `${r.created ? "generated in memory and POSTed (public key + wrapped blobs only)" : "existing bundle unlocked with the wallet signature"}; keyId ${r.keys.keyId}`, value: r.keys };
  });

  // ---- c. username
  const claim = await step("c username", async () => {
    const r = await ensureUsername(api, username, say);
    addTxs("username", r.txs);
    return { note: `${r.ensName} claimed; onboarding done; txs: ${r.txs.filter((s) => s.txHash).map((s) => `${s.id} ${s.txHash}`).join(", ") || "none this run (resumed)"}`, value: r };
  });
  const bal1 = await operatorBalanceEth(env);
  if (bal1 && bal1.eth < MIN_OPERATOR_ETH) throw new Error(`operator balance ${bal1.eth.toFixed(4)} ETH dropped below ${MIN_OPERATOR_ETH}: stopping`);

  // ---- d. agent
  const agent = (await step("d agent", async () => {
    const a = await ensureAgent(api, keys!, "alex", say);
    addTxs("agent", a.txs);
    return { note: `${a.ensName} active (index ${a.index}), email ${a.email}, wallet ${a.walletAddress}, ${a.created ? "created" : "reused"}; txs: ${a.txs.filter((s) => s.txHash).map((s) => `${s.id} ${s.txHash}`).join(", ") || "none this run"}`, value: a };
  }))!;
  agentInfo = agent;
  const bal2 = await operatorBalanceEth(env);
  if (bal2 && bal2.eth < MIN_OPERATOR_ETH) throw new Error(`operator balance ${bal2.eth.toFixed(4)} ETH dropped below ${MIN_OPERATOR_ETH}: stopping`);

  // ---- e. ENS resolution through UniversalResolverV2 + permissions
  const ens = readOnlyEns(env.sepoliaRpc);
  const resolved = await step("e ENS resolve", async () => {
    const r = await waitFor("ENS resolution", async () => {
      const x = await ens.resolveAgent(agent.ensName);
      return x.address && x.email ? x : null;
    }, { timeoutMs: 90_000, intervalMs: 3000 });
    must(r.address?.toLowerCase() === agent.walletAddress.toLowerCase(), "ENS addr != derived agent wallet");
    must(r.email?.toLowerCase() === agent.email.toLowerCase(), "ENS email != mailbox address");
    const perms = await ens.getAgentPermissions(agent.ensName, agent.walletAddress as `0x${string}`);
    const writable = Object.entries(perms.text).filter(([, v]) => v).map(([k]) => k);
    must(writable.length === 1 && writable[0] === "agent-context" && !perms.address, `unexpected agent permissions: ${writable.join(",")} addr=${perms.address}`);
    return { note: `addr ${r.address} email ${r.email} policy=${r.sendPolicy.policy} limit=${r.sendPolicy.limit} allow=${r.sendPolicy.allow.length}; agent may write only [${writable.join(",")}]`, value: r };
  });
  const defaultPolicy = resolved!.sendPolicy.policy;

  // ---- f. inbound (fake Resend webhook) + inbox + agent API
  const convRes = await step("f1 inbound conversation", async () => {
    const r = await sendFakeWebhook({ to: agent.email, fixture: "conv", secret: env.webhookSecret, url: `${env.apiUrl}/webhooks/resend` });
    must(r.status === 200 && r.body.includes("stored"), `webhook answered ${r.status} ${r.body.slice(0, 80)}`);
    return { note: `webhook 200 ${r.body}`, value: r };
  });
  const otpRes = await step("f2 inbound otp", async () => {
    const r = await sendFakeWebhook({ to: agent.email, fixture: "otp", secret: env.webhookSecret, url: `${env.apiUrl}/webhooks/resend` });
    must(r.status === 200 && r.body.includes("stored"), `webhook answered ${r.status} ${r.body.slice(0, 80)}`);
    otpInfo.writtenAtBlock = await arkivBlockNumber(env.arkivRpc);
    return { note: `webhook 200 ${r.body}; arkiv block ${otpInfo.writtenAtBlock}`, value: r };
  });
  void convRes;
  void otpRes;

  let convEntity: MailEntity | undefined;
  let otpEntity: MailEntity | undefined;
  await step("f3 user inbox + client-side decrypt", async () => {
    const found = await waitFor("both mails in the inbox", async () => {
      const items = await decryptAll(await listInbox(api, agent.id), keys!);
      const conv = items.find((x) => x.mail?.subject === CONV.subject);
      const otp = items.find((x) => x.mail?.subject === OTP.subject);
      return conv && otp ? { conv, otp } : null;
    }, { timeoutMs: 120_000, intervalMs: 3000 });
    convEntity = found.conv.entity;
    otpEntity = found.otp.entity;
    const c = found.conv.mail!;
    const o = found.otp.mail!;
    const checks = {
      "conv subject matches": c.subject === CONV.subject,
      "conv body matches": c.body.includes(CONV.bodyHas),
      "conv meta.from matches": c.meta?.from === CONV.from,
      "conv meta.messageId set": typeof c.meta?.messageId === "string" && c.meta.messageId.startsWith("<"),
      "conv meta.links has the shared folder": !!c.meta?.links?.includes(CONV.link),
      "conv type conversation": found.conv.entity.type === "conversation",
      "otp subject matches": o.subject === OTP.subject,
      "otp meta.otp matches": o.meta?.otp === OTP.code,
      "otp meta.from matches": o.meta?.from === OTP.from,
      "otp type otp": found.otp.entity.type === "otp",
      "owner is the user wallet": found.conv.entity.owner.toLowerCase() === account.address.toLowerCase(),
      "creator is the arkiv operator": found.conv.entity.creator.toLowerCase() === arkivOperator.toLowerCase(),
    };
    for (const [k, v] of Object.entries(checks)) say(`    ${v ? "ok  " : "FAIL"} ${k}`);
    must(Object.values(checks).every(Boolean), `failed checks: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join("; ")}`);
    entities.push({ what: "conversation (inbound)", key: convEntity.key }, { what: "otp (inbound)", key: otpEntity.key });
    return { note: `conv ${convEntity.key}, otp ${otpEntity.key}` };
  });

  await step("f4 agent API (/v1) decrypt", async () => {
    const inbox = await api.get("/v1/inbox?limit=50", { token: agent.token });
    must(inbox.status === 200, `/v1/inbox answered ${inbox.status}`);
    const keysListed = (inbox.json.items as Array<{ entityKey: string }>).map((i) => i.entityKey);
    must(keysListed.includes(convEntity!.key) && keysListed.includes(otpEntity!.key), "both entities listed by /v1/inbox");
    const conv = await api.get(`/v1/emails/${convEntity!.key}`, { token: agent.token });
    const otp = await api.get("/v1/otp/latest", { token: agent.token });
    const checks = {
      "/v1/emails conv 200": conv.status === 200,
      "agent sees subject": conv.json?.untrusted?.subject === CONV.subject,
      "agent sees body": String(conv.json?.untrusted?.body ?? "").includes(CONV.bodyHas),
      "content_trust untrusted": conv.json?.content_trust === "untrusted",
      "/v1/otp/latest 200": otp.status === 200,
      "agent otp matches": otp.json?.otp === OTP.code,
      "bad token 401": (await api.get("/v1/inbox", { token: "nan_" + "A".repeat(43) })).status === 401,
    };
    for (const [k, v] of Object.entries(checks)) say(`    ${v ? "ok  " : "FAIL"} ${k}`);
    must(Object.values(checks).every(Boolean), `failed checks: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join("; ")}`);
    return { note: "agent token decrypts conversation and latest OTP; bad token rejected" };
  });

  // ---- g. Arkiv raw query: ciphertext only
  await step("g arkiv raw query", async () => {
    for (const [what, e] of [["conversation", convEntity!], ["otp", otpEntity!]] as const) {
      const q = await rawQueryByKey(env.arkivRpc, e.key, arkivOperator);
      must(q.entities.length === 1, `${what}: expected 1 entity from the raw query, got ${q.entities.length}`);
      const ent = q.entities[0]!;
      must(ent.creator === arkivOperator.toLowerCase(), `${what}: creator is not the operator`);
      must(ent.owner === account.address.toLowerCase(), `${what}: owner is not the user wallet`);
      const lower = q.raw.toLowerCase();
      // The raw response is hex/base64-ish binary plus opaque attributes: none of the plaintext may appear in it.
      const hits = LEAK_NEEDLES.filter((n) => lower.includes(n.toLowerCase()));
      must(hits.length === 0, `${what}: plaintext found in the raw Arkiv response (${hits.length} needles)`);
      say(`    ok   ${what}: ${q.raw.length} raw bytes, owner=user, creator=operator, no plaintext (${LEAK_NEEDLES.length} needles absent)`);
      if (what === "otp") {
        otpInfo.key = e.key;
        otpInfo.expiresAtBlock = ent.expiresAtBlock;
      }
    }
    return { note: `both entities: owner ${account.address}, creator ${arkivOperator}, ciphertext only; otp expires at block ${otpInfo.expiresAtBlock}` };
  });

  // ---- h. outbound send policy
  await step("h outbound", async () => {
    const pol = await api.get(`/agents/${agent.id}/send-policy`);
    must(pol.status === 200, `GET send-policy ${pol.status}`);
    say(`    default policy: ${pol.json.policy} (allow ${pol.json.allow.length}, limit ${pol.json.limit})`);
    must(pol.json.policy === "reply-only", `default policy is ${pol.json.policy}, expected reply-only`);

    const send = (to: string, tag: string) =>
      api.post("/v1/emails/send", { to, subject: `Live e2e ${tag}`, body: `Live e2e ${tag} body ${Date.now()}` }, { token: agent.token });
    const reply = await send(CONV.from, "reply");
    must(reply.status === 200, `reply to the inbound sender answered ${reply.status} ${reply.json?.error ?? ""}`);
    must(/^fake-sent-/.test(reply.json.providerMessageId), "provider is not the FAKE provider: stop (no real mail may be sent)");
    must(typeof reply.json.entityKey === "string", `sent copy missing: ${reply.json.sentCopy ?? ""}`);
    entities.push({ what: "sent copy (reply to inbound sender)", key: reply.json.entityKey });
    say(`    ok   reply-only allows the inbound sender: 200, sent copy ${reply.json.entityKey}`);

    const denied = await send(STRANGER, "stranger-denied");
    must(denied.status === 403 && denied.json.error === "policy_reply_only", `stranger answered ${denied.status} ${denied.json?.error ?? ""}`);
    say("    ok   stranger denied under reply-only: 403 policy_reply_only");

    const put = await api.put(`/agents/${agent.id}/send-policy`, { policy: "allowlist", allow: [STRANGER], limit: 50 });
    must(put.status === 202, `PUT send-policy answered ${put.status} ${put.json?.error ?? ""}`);
    const job = await waitFor("policy job", async () => {
      const s = await api.get(`/agents/${agent.id}/status`);
      if (s.json.kind === "policy" && s.json.status === "error") throw Object.assign(new Error(`policy job failed: ${s.json.error?.message ?? ""}`), { fatal: true });
      return s.json.kind === "policy" && s.json.status === "done" ? s.json : null;
    }, { timeoutMs: 5 * 60_000, intervalMs: 3000 });
    addTxs("send policy", job.steps as Step[]);
    say(`    ok   policy job done; txs ${(job.steps as Step[]).filter((s) => s.txHash).map((s) => s.txHash).join(", ")}`);

    const after = await waitFor("policy read back", async () => {
      const p = await api.get(`/agents/${agent.id}/send-policy`);
      return p.json.policy === "allowlist" && p.json.allow.includes(STRANGER) ? p.json : null;
    }, { timeoutMs: 90_000, intervalMs: 3000 });
    say(`    ok   ENS now says policy=${after.policy} allow=[${after.allow.join(",")}] limit=${after.limit}`);

    const allowed = await send(STRANGER, "stranger-allowed");
    must(allowed.status === 200, `stranger after allowlist answered ${allowed.status} ${allowed.json?.error ?? ""}`);
    must(/^fake-sent-/.test(allowed.json.providerMessageId), "provider is not the FAKE provider");
    entities.push({ what: "sent copy (allowlisted stranger)", key: allowed.json.entityKey });
    say(`    ok   allowlisted stranger: 200, sent copy ${allowed.json.entityKey}`);

    const sent = await waitFor("sent copies in the inbox", async () => {
      const dec = await decryptAll(await listInbox(api, agent.id, "sent"), keys!);
      return dec.filter((d) => d.mail).length >= 2 ? dec : null;
    }, { timeoutMs: 120_000, intervalMs: 3000 });
    const toSet = new Set(sent.map((d) => d.mail?.meta?.to));
    must(toSet.has(CONV.from) && toSet.has(STRANGER), "sent copies do not carry both recipients in meta.to");
    must(sent.every((d) => d.mail?.meta?.direction === "sent" && d.entity.type === "sent"), "sent copy metadata wrong");
    say(`    ok   ${sent.length} sent copies decrypt client-side (type sent, meta.to, direction sent)`);
    return { note: `default policy reply-only; reply 200, stranger 403, allowlist set on-chain, stranger 200; ${sent.length} sent copies decrypt` };
  });

  // ---- j (Part C). OTP expiry: the entity must vanish from queries after its expiry block
  await step("j otp expiry", async () => {
    must(otpInfo.key && otpInfo.expiresAtBlock, "no OTP entity recorded");
    say(`    otp ${otpInfo.key} expires at block ${otpInfo.expiresAtBlock}; waiting for it to disappear from raw queries`);
    const t0 = Date.now();
    await waitFor("OTP entity to disappear", async () => {
      const q = await rawQueryByKey(env.arkivRpc, otpInfo.key!, arkivOperator);
      if (q.entities.length > 0) {
        otpInfo.lastSeenBlock = q.atBlock;
        otpInfo.lastSeenAtMs = Date.now();
        return null;
      }
      otpInfo.goneAtBlock = q.atBlock;
      otpInfo.goneAtMs = Date.now();
      return true;
    }, { timeoutMs: 9 * 60_000, intervalMs: 4000 });
    must(otpInfo.goneAtBlock! >= otpInfo.expiresAtBlock!, `entity vanished at block ${otpInfo.goneAtBlock} BEFORE its expiry block ${otpInfo.expiresAtBlock}`);
    // The same must hold through the product paths.
    const inboxOtp = (await listInbox(api, agent.id, "otp")).map((e) => e.key);
    must(!inboxOtp.includes(otpInfo.key!), "expired OTP still listed in the user inbox");
    const latest = await api.get("/v1/otp/latest", { token: agent.token });
    must(latest.status === 404, `/v1/otp/latest answered ${latest.status} after expiry, expected 404`);
    const conv = await rawQueryByKey(env.arkivRpc, convEntity!.key, arkivOperator);
    must(conv.entities.length === 1, "conversation entity should still exist");
    const blocksPast = otpInfo.goneAtBlock! - otpInfo.expiresAtBlock!;
    return {
      note: `expiresAtBlock ${otpInfo.expiresAtBlock}; last seen present at block ${otpInfo.lastSeenBlock ?? "(not seen)"}; first absent at block ${otpInfo.goneAtBlock} (${blocksPast} block(s) past expiry); user inbox type=otp no longer lists it; /v1/otp/latest 404; conversation still there (expires block ${conv.entities[0]!.expiresAtBlock}); waited ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    };
  });

  // ---- i. revoke
  await step("i revoke", async () => {
    const r = await api.post(`/agents/${agent.id}/revoke`);
    must(r.status === 202 || r.status === 200, `revoke answered ${r.status}`);
    const t = await api.get("/v1/inbox", { token: agent.token });
    must(t.status === 401, `agent token answered ${t.status} after revoke, expected 401`);
    say("    ok   agent token now 401");
    const job = await waitFor("revoke job", async () => {
      const s = await api.get(`/agents/${agent.id}/status`);
      if (s.json.kind === "revoke" && s.json.status === "error") throw Object.assign(new Error(`revoke job failed: ${s.json.error?.message ?? ""}`), { fatal: true });
      return s.json.kind === "revoke" && s.json.status === "done" ? s.json : null;
    }, { timeoutMs: 5 * 60_000, intervalMs: 3000 });
    addTxs("revoke", job.steps as Step[]);
    const perms = await waitFor("ENS permissions gone", async () => {
      const p = await ens.getAgentPermissions(agent.ensName, agent.walletAddress as `0x${string}`);
      return Object.values(p.text).every((v) => !v) && !p.address ? p : null;
    }, { timeoutMs: 90_000, intervalMs: 3000 });
    void perms;
    const send = await api.post("/v1/emails/send", { to: STRANGER, subject: "x", body: "x" }, { token: agent.token });
    must(send.status === 401, `send with the revoked token answered ${send.status}`);
    return { note: `token 401 (inbox and send); revoke txs ${(job.steps as Step[]).filter((s) => s.txHash).map((s) => s.txHash).join(", ")}; getAgentPermissions: no text record and no address writable by the agent wallet` };
  });

  const end = await operatorBalanceEth(env);
  balanceEnd = end?.eth;
} catch (e) {
  if (!failures.length) failures.push(`unexpected: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
  const end = await operatorBalanceEth(env).catch(() => null);
  balanceEnd = end?.eth;
}

// ---- report
const ok = failures.length === 0;
say("");
say(ok ? "ALL STEPS PASSED" : `FAILED: ${failures.join(" | ")}`);
const lines: string[] = [];
lines.push("", `## Run ${runStarted.toISOString()} (${ok ? "all steps passed" : "FAILED"})`, "");
lines.push(`- Username: \`${username}\` -> \`${username}.nanitecom.eth\`${agentInfo ? `; agent \`${agentInfo.ensName}\`, mailbox \`${agentInfo.email}\`, agent wallet \`${agentInfo.walletAddress}\`` : ""}`);
lines.push(`- Test user wallet \`${account.address}\`; ENS operator \`${operatorAddr}\` (balance ${balanceStart?.toFixed(4) ?? "?"} -> ${balanceEnd?.toFixed(4) ?? "?"} ETH); Arkiv operator \`${arkivOperator}\`.`);
lines.push(`- API \`${env.apiUrl}\`; inbound via the signed fake Resend webhook, outbound via FAKE_RESEND_SEND (no real email).`, "");
lines.push("| step | result | time | detail |", "| --- | --- | --- | --- |");
for (const r of results) lines.push(`| ${r.step} | ${r.ok ? "pass" : "**FAIL**"} | ${(r.ms / 1000).toFixed(1)}s | ${r.note.replace(/\|/g, "\\|")} |`);
if (txs.length) {
  lines.push("", "Sepolia transactions:", "");
  for (const t of txs) lines.push(`- ${t.what}: [\`${t.hash}\`](${txLink(t.hash)})`);
}
if (entities.length) {
  lines.push("", "Arkiv entities (ciphertext only; owner = user wallet, creator = Arkiv operator):", "");
  for (const x of entities) lines.push(`- ${x.what}: [\`${x.key}\`](${entityLink(x.key)})`);
}
if (otpInfo.key) {
  lines.push("", "OTP expiry (T4.1):", "", `- Entity [\`${otpInfo.key}\`](${entityLink(otpInfo.key)}), written near Arkiv block ${otpInfo.writtenAtBlock ?? "?"}, \`expiresAt\` = block ${otpInfo.expiresAtBlock ?? "?"}.`);
  lines.push(`- Last raw query that still returned it: block ${otpInfo.lastSeenBlock ?? "n/a"}; first raw query without it: block ${otpInfo.goneAtBlock ?? "n/a (did not vanish within the wait)"}.`);
}
for (const x of extra) lines.push(x);
if (failures.length) {
  lines.push("", "Failures:", "");
  for (const f of failures) lines.push(`- ${f}`);
}
lines.push("");
if (!existsSync(DOC)) writeFileSync(DOC, "# Live end-to-end runs\n");
appendFileSync(DOC, lines.join("\n"));
say(`run appended to apps/api/LIVE-E2E.md`);
await sleep(50);
process.exit(ok ? 0 : 1);
