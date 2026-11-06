/*
 * First real-email test, part 1: create agent `mail` for the demo user (SHARED_MAIL_DOMAIN mailbox), publish its
 * signer, set the send policy to allowlist, resolve ENS, save the token to apps/api/.live-agent-token (mode 600).
 * Prints addresses, tx hashes and records only. Never prints tokens, keys or email content.
 *
 *   docker compose run --rm -e API_URL=http://nanite-api-live:4000 tools npx tsx apps/api/scripts/live-mail-agent.ts
 */
import { chmodSync, writeFileSync } from "node:fs";
import {
  ApiClient, MIN_OPERATOR_ETH, ensureAgent, ensureKeys, loadLiveEnv, operatorBalanceEth, readOnlyEns, siweLogin, userAccount, waitFor,
} from "./lib/live.js";

const ALLOW = "vikrantsingh202004@gmail.com";
const env = loadLiveEnv();
const api = new ApiClient(env.apiUrl, env.webOrigin);
const say = (l: string) => console.log(l);

try {
  const bal = await operatorBalanceEth(env);
  say(`operator ${bal?.address} balance ${bal?.eth.toFixed(4)} ETH`);
  if (bal && bal.eth < MIN_OPERATOR_ETH) throw new Error("operator balance below 0.05 ETH: stop");
  const account = userAccount(env);
  const me = await siweLogin(api, account, env.webOrigin);
  const { keys } = await ensureKeys(api, account, me);
  say(`signed in ${account.address} as ${me.username}`);

  const agent = await ensureAgent(api, keys, "mail", say, { rotateToken: true });
  say(`agent id ${agent.id} ens ${agent.ensName} email ${agent.email} wallet ${agent.walletAddress} created=${agent.created}`);
  for (const s of agent.txs) if (s.txHash) say(`  tx ${s.id}: ${s.txHash}`);
  writeFileSync("apps/api/.live-agent-token", agent.token, { mode: 0o600 });
  chmodSync("apps/api/.live-agent-token", 0o600);
  say("token saved to apps/api/.live-agent-token");

  // publish signer
  const post = await api.post(`/agents/${agent.id}/signer`);
  if (post.status !== 202) throw new Error(`POST signer ${post.status} ${post.json?.error ?? ""}`);
  const sjob = await waitFor("signer job", async () => {
    const s = await api.get(`/agents/${agent.id}/status`);
    if (s.json.kind === "signer" && s.json.status === "error") throw Object.assign(new Error(`signer job failed: ${s.json.error?.message ?? ""}`), { fatal: true });
    return s.json.kind === "signer" && s.json.status === "done" ? s.json : null;
  }, { timeoutMs: 5 * 60_000, intervalMs: 3000 });
  for (const s of sjob.steps as Array<{ id: string; txHash?: string }>) if (s.txHash) say(`  tx ${s.id}: ${s.txHash}`);

  // send policy
  const put = await api.put(`/agents/${agent.id}/send-policy`, { policy: "allowlist", allow: [ALLOW], limit: 10 });
  if (put.status !== 202) throw new Error(`PUT send-policy ${put.status} ${put.json?.error ?? ""}`);
  const pjob = await waitFor("policy job", async () => {
    const s = await api.get(`/agents/${agent.id}/status`);
    if (s.json.kind === "policy" && s.json.status === "error") throw Object.assign(new Error(`policy job failed: ${s.json.error?.message ?? ""}`), { fatal: true });
    return s.json.kind === "policy" && s.json.status === "done" ? s.json : null;
  }, { timeoutMs: 5 * 60_000, intervalMs: 3000 });
  for (const s of pjob.steps as Array<{ id: string; txHash?: string }>) if (s.txHash) say(`  tx ${s.id}: ${s.txHash}`);

  const ens = readOnlyEns(env.sepoliaRpc);
  const r = await waitFor("ENS records", async () => {
    const x = await ens.resolveAgent(agent.ensName);
    return x.sendPolicy && x.signer ? x : null;
  }, { timeoutMs: 120_000, intervalMs: 4000 });
  say(`ENS resolved: ${JSON.stringify(r)}`.replace(/"pubkey":"[^"]*"/, '"pubkey":"<omitted>"'));
  process.exit(0);
} catch (e) {
  console.error(`failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
  process.exit(1);
}
