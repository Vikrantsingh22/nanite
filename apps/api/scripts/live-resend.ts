/*
 * LIVE Resend checks for the dev stack (database `nanite_live`, see apps/api/LIVE-E2E.md "Databases").
 * Needs RESEND_API_KEY (Full access) and SHARED_MAIL_DOMAIN in the local .env. Never prints the key, an agent
 * token, a session cookie or any email content (only booleans, ids, statuses and DNS records).
 *
 *   docker compose run --rm tools npx tsx apps/api/scripts/live-resend.ts --create-domain [--region=ap-northeast-1]
 *       Idempotent: GET /domains first; creates SHARED_MAIL_DOMAIN only if missing (sending + receiving, tracking
 *       off, opportunistic TLS), prints the DNS records and writes docs/resend-dns-records.md.
 *   ... --verify          POST /domains/{id}/verify, then print the per-record status.
 *   ... --check           Print status, region and each record's type/name/status of SHARED_MAIL_DOMAIN only.
 *   ... --send-test --to=<addr> [--agent-name=alex] [--api=http://nanite-api-live:4000]
 *       Sends ONE real mail from the demo agent through POST /v1/emails/send (the API must run WITHOUT
 *       FAKE_RESEND_SEND, with RESEND_API_KEY and SHARED_MAIL_DOMAIN). It ROTATES the agent's API token (kept in
 *       memory only, the old token stops working). Prints the provider id, the signature result and Resend's
 *       delivery state.
 *   ... --wait-inbound --agent=<agent id> [--timeout=300] [--api=...]
 *       Polls the user inbox (session as the test wallet) until a NEW non-sent mail arrives, decrypts it and prints
 *       booleans only: subject present, from present, otp detected.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApiClient,
  decryptMail,
  ensureKeys,
  listInbox,
  loadLiveEnv,
  siweLogin,
  sleep,
  userAccount,
} from "./lib/live.js";
import {
  REGIONS,
  ResendAdminError,
  createResendAdmin,
  recordRows,
  renderConsole,
  renderMarkdown,
  type DomainInfo,
  type Region,
} from "./lib/resend-admin.js";

const DNS_DOC = fileURLToPath(new URL("../../../docs/resend-dns-records.md", import.meta.url));
const flag = (name: string) => process.argv.includes(`--${name}`);
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const say = (l = "") => console.log(l);

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is missing: set it in the local .env (the value is never printed)`);
  return v;
}

function printDomain(d: DomainInfo) {
  say(renderConsole(d));
}

async function main() {
  const modes = ["check", "create-domain", "verify", "send-test", "wait-inbound"].filter(flag);
  if (modes.length !== 1) throw new Error("choose exactly one of --check, --create-domain, --verify, --send-test, --wait-inbound (see the header of this file)");
  const mode = modes[0]!;

  if (mode === "check" || mode === "create-domain" || mode === "verify") {
    const admin = createResendAdmin(need("RESEND_API_KEY"));
    const name = need("SHARED_MAIL_DOMAIN");
    if (mode === "create-domain") {
      const region = (arg("region") ?? "us-east-1") as Region;
      if (!REGIONS.includes(region)) throw new Error(`--region must be one of ${REGIONS.join(", ")}`);
      const { domain, created } = await admin.ensureDomain(name, region);
      say(created ? `created ${name}` : `${name} already exists, not created again`);
      printDomain(domain);
      mkdirSync(dirname(DNS_DOC), { recursive: true });
      writeFileSync(DNS_DOC, renderMarkdown(domain));
      say(`\nwrote docs/resend-dns-records.md`);
      return;
    }
    const domain = await admin.findDomain(name);
    if (!domain) throw new Error(`${name} is not a domain of this Resend account (run --create-domain)`);
    if (mode === "verify") {
      await admin.verifyDomain(domain.id);
      say(`verification started for ${name}; reading the result`);
      await sleep(3000);
      printDomain(await admin.getDomain(domain.id));
      return;
    }
    say(`${domain.name}: status ${domain.status}, region ${domain.region}`);
    for (const r of recordRows(domain).rows.filter((x) => x.status !== "-")) say(`  ${r.type.padEnd(5)} ${r.host.padEnd(40)} ${r.status}`);
    return;
  }

  // ---- modes that act as the demo user through the API
  const env = loadLiveEnv({ ...process.env, ...(arg("api") ? { API_URL: arg("api") } : {}) });
  const api = new ApiClient(env.apiUrl, env.webOrigin);
  const me = await siweLogin(api, userAccount(env), env.webOrigin);
  if (!me.username) throw new Error("test user has no username in this database (use nanite_live, see LIVE-E2E.md)");

  if (mode === "send-test") {
    const to = arg("to");
    if (!to || !/^[^\s@]+@[^\s@]+$/.test(to)) throw new Error("--to=<address> is required");
    const agentName = arg("agent-name") ?? "alex";
    const agent = ((await api.get("/agents")).json.agents as any[]).find((a) => a.name === agentName && a.status === "active");
    if (!agent) throw new Error(`no active agent "${agentName}" for ${me.username}`);
    const rot = await api.post(`/agents/${agent.id}/token`); // in memory only, never printed
    if (rot.status !== 201) throw new Error(`token rotation answered ${rot.status}`);
    const sent = await api.post(
      "/v1/emails/send",
      { to, subject: "Nanite live send test", body: "Hello from a Nanite agent. This is a live test of outbound mail and its signature." },
      { token: rot.json.token as string },
    );
    if (sent.status !== 200) throw new Error(`POST /v1/emails/send answered ${sent.status} ${sent.json?.error ?? ""}`);
    const providerId = String(sent.json.providerMessageId);
    if (providerId.startsWith("fake-sent-")) say("WARNING: the API used the FAKE provider, no real mail was sent (start it without FAKE_RESEND_SEND)");
    say(`sent from ${agent.ensName}: provider id ${providerId}`);
    say(`signature: ${sent.json.signature}${sent.json.sentCopy === "failed" ? " (sent copy on Arkiv failed)" : ""}${sent.json.threading ? " (threading unavailable)" : ""}`);
    if (!providerId.startsWith("fake-sent-") && process.env.RESEND_API_KEY?.trim()) {
      await sleep(3000);
      const r = await fetch(`https://api.resend.com/emails/${encodeURIComponent(providerId)}`, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}` } }).catch(() => null);
      const last = r && r.ok ? ((await r.json()) as { last_event?: unknown }).last_event : undefined;
      say(`Resend delivery state: ${typeof last === "string" ? last : "unknown"}`);
    }
    return;
  }

  // wait-inbound
  const agentId = arg("agent");
  if (!agentId) throw new Error("--agent=<agent id> is required");
  const timeoutS = Number(arg("timeout") ?? "300");
  const { keys } = await ensureKeys(api, userAccount(env), me);
  const seen = new Set((await listInbox(api, agentId)).map((e) => e.key));
  say(`baseline: ${seen.size} existing mails; waiting up to ${timeoutS}s for a new one (send a mail to the agent's address now)`);
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    await sleep(5000);
    const fresh = (await listInbox(api, agentId)).filter((e) => !seen.has(e.key) && e.type !== "sent");
    const e = fresh[0];
    if (!e) continue;
    const mail = await decryptMail(e, keys);
    say(`new mail ${e.key} (type ${e.type})`);
    say(`  decrypted: ${mail !== null}`);
    say(`  subject present: ${!!mail?.subject}`);
    say(`  from present: ${typeof mail?.meta?.from === "string" && mail.meta.from.length > 0}`);
    say(`  otp detected: ${e.type === "otp" || !!mail?.meta?.otp}`);
    return;
  }
  throw new Error(`no new mail within ${timeoutS}s`);
}

main().then(
  () => process.exit(0),
  (e) => {
    const msg = e instanceof ResendAdminError ? e.message : e instanceof Error ? e.message : String(e);
    console.error(`FAILED: ${msg.slice(0, 300)}`);
    process.exit(1);
  },
);
