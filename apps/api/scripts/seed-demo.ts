/*
 * Idempotent demo seed (T4.1) through the REAL API path, as the test user wallet:
 * SIWE sign-in -> keys -> username -> two agents (real Sepolia txs, only what is missing) -> a handful of
 * realistic FAKE inbound emails through the signed fake Resend webhook (real Arkiv writes, only what is missing).
 * No real email is sent or received. Needs the API running with FAKE_RESEND_CONTENT=1.
 *
 *   docker compose run --rm tools npx tsx apps/api/scripts/seed-demo.ts [--username=nanitedemo] [--api=http://api:4000]
 *
 * Re-run it right before a demo: conversation mail lives about 6 months, but OTPs expire after 5 minutes by
 * design, so a re-run sends fresh OTPs (and nothing else). The wallet must not already be bound to the legacy
 * placeholder `vikrant` row made by `npm run db:seed` (that row has dummy keys); use a database without it
 * (LIVE-E2E.md, "Databases"). Prints step results, addresses and entity keys only; no tokens, keys or content.
 */
import { FAKE_FIXTURES } from "../src/mail/fake.js";
import { sendFakeWebhook } from "./lib/fake-webhook.js";
import {
  ApiClient,
  MIN_OPERATOR_ETH,
  decryptAll,
  ensureAgent,
  ensureKeys,
  ensureUsername,
  entityLink,
  listInbox,
  loadLiveEnv,
  operatorBalanceEth,
  siweLogin,
  userAccount,
  waitFor,
  type AgentInfo,
} from "./lib/live.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const env = loadLiveEnv({ ...process.env, ...(arg("api") ? { API_URL: arg("api") } : {}) });
const account = userAccount(env);
const api = new ApiClient(env.apiUrl, env.webOrigin);
const say = (l: string) => console.log(l);

/** agent label -> fixtures (subject comes from the fixture itself, so re-runs can detect what exists). */
const PLAN: Array<{ agent: string; fixtures: string[] }> = [
  { agent: "alex", fixtures: ["conv", "otp"] },
  { agent: "scout", fixtures: ["newsletter", "receipt", "otp2"] },
];

try {
  const bal = await operatorBalanceEth(env);
  if (bal && bal.eth < MIN_OPERATOR_ETH) throw new Error(`ENS operator balance ${bal.eth.toFixed(4)} ETH is below ${MIN_OPERATOR_ETH}: stop`);
  const me = await siweLogin(api, account, env.webOrigin);
  say(`signed in as ${account.address} (state ${me.onboardingState})`);
  const username = me.username ?? arg("username") ?? "nanitedemo";
  const { keys, created } = await ensureKeys(api, account, me);
  say(`keys: ${created ? "created" : "already present, unlocked with the wallet signature"} (keyId ${keys.keyId})`);
  const claim = await ensureUsername(api, username, say);
  say(`username: ${claim.ensName}`);

  const agents: AgentInfo[] = [];
  for (const p of PLAN) {
    const a = await ensureAgent(api, keys, p.agent, say, { rotateToken: false });
    agents.push(a);
    say(`agent: ${a.ensName} <${a.email}> wallet ${a.walletAddress} ${a.created ? "(created)" : "(already there)"}`);
  }

  let sent = 0;
  for (const p of PLAN) {
    const agent = agents.find((a) => a.name === p.agent)!;
    const have = new Set((await decryptAll(await listInbox(api, agent.id), keys)).map((d) => d.mail?.subject));
    for (const f of p.fixtures) {
      const subject = FAKE_FIXTURES[f]!.subject!;
      if (have.has(subject)) {
        say(`  ${agent.name}: "${f}" already in the inbox, skipped`);
        continue;
      }
      const r = await sendFakeWebhook({ to: agent.email, fixture: f, secret: env.webhookSecret, url: `${env.apiUrl}/webhooks/resend` });
      if (r.status !== 200) throw new Error(`webhook for ${f} answered ${r.status}`);
      const entity = await waitFor(`${f} in the inbox`, async () => {
        const dec = await decryptAll(await listInbox(api, agent.id), keys);
        return dec.find((d) => d.mail?.subject === subject)?.entity;
      }, { timeoutMs: 120_000, intervalMs: 3000 });
      sent++;
      say(`  ${agent.name}: "${f}" stored, ${entity.type}, entity ${entity.key}  ${entityLink(entity.key)}`);
    }
  }
  say(`done: ${agents.length} agents, ${sent} new emails (${username}.nanitecom.eth); unlock the dashboard with the test user wallet`);
  process.exit(0);
} catch (e) {
  console.error(`seed failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
  process.exit(1);
}
