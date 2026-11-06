/*
 * First live check of the self-hosted agent kit (T3.7), part 1: create agent `kit` with custody self (keys from
 * `nanite-mcp keygen`), publish its signer, set the send policy to allowlist, resolve ENS, confirm the server refuses
 * to decrypt for it. Reads ONLY the public values of the key file; saves the agent token to <keydir>/token (mode 600).
 * Prints addresses, tx hashes, records and statuses only. Never prints tokens, keys or email content.
 *
 *   docker compose run --rm -v "$PWD/apps/api/.live-selfhosted:/keys" -e API_URL=http://nanite-api-live:4000 tools \
 *     npx tsx apps/api/scripts/live-selfhosted-part1.ts
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { deriveAgentWallet } from "@nanite/crypto";
import {
  ApiClient, MIN_OPERATOR_ETH, ensureKeys, loadLiveEnv, operatorBalanceEth, readOnlyEns, siweLogin, userAccount, waitFor,
} from "./lib/live.js";

const KEYDIR = process.env.KEYDIR ?? "/keys";
const ALLOW = "vikrantsingh202004@gmail.com";
const NAME = "kit";
const env = loadLiveEnv();
const api = new ApiClient(env.apiUrl, env.webOrigin);
const say = (l: string) => console.log(l);

async function job(id: string, kind: string) {
  return waitFor(`${kind} job`, async () => {
    const s = await api.get(`/agents/${id}/status`);
    if (s.json.status === "error") throw Object.assign(new Error(`${kind} job failed: ${s.json.error?.message ?? ""}`), { fatal: true });
    return s.json.kind === kind && s.json.status === "done" ? s.json : null;
  }, { timeoutMs: 6 * 60_000, intervalMs: 3000 });
}

try {
  const pub = JSON.parse(readFileSync(`${KEYDIR}/agent-key.json`, "utf8")) as { encryptionPublicKey: string; signerAddress: string };
  const encryptionPublicKey = pub.encryptionPublicKey;
  const signerAddress = pub.signerAddress;
  say(`keygen public values: signer ${signerAddress}`);

  const bal = await operatorBalanceEth(env);
  say(`operator ${bal?.address} balance ${bal?.eth.toFixed(4)} ETH`);
  if (bal && bal.eth < MIN_OPERATOR_ETH) throw new Error("operator balance below 0.05 ETH: stop");

  const account = userAccount(env);
  const me = await siweLogin(api, account, env.webOrigin);
  const { keys } = await ensureKeys(api, account, me);
  say(`signed in ${account.address} as ${me.username}`);

  const list = await api.get("/agents");
  if ((list.json.agents as any[]).some((a) => a.name === NAME && a.status !== "revoked")) throw new Error("agent kit already exists");
  let index = (list.json.agents as any[]).length;
  let agent: any;
  let token = "";
  for (let attempt = 0; attempt < 2 && !agent; attempt++) {
    const wallet = await deriveAgentWallet(keys.seed, index);
    const r = await api.post("/agents", { name: NAME, index, walletAddress: wallet.address, encryptionPublicKey, signerAddress });
    if (r.status === 409 && r.json?.error === "index_mismatch" && typeof r.json.expected === "number") { index = r.json.expected; continue; }
    if (r.status !== 202) throw new Error(`POST /agents answered ${r.status} ${r.json?.error ?? ""}`);
    agent = r.json.agent;
    token = r.json.token;
  }
  if (!agent) throw new Error("could not create the agent");
  writeFileSync(`${KEYDIR}/token`, token, { mode: 0o600 });
  chmodSync(`${KEYDIR}/token`, 0o600);
  say(`token saved to ${KEYDIR}/token`);
  say(`agent id ${agent.id} ens ${agent.ensName} email ${agent.email} wallet ${agent.walletAddress} index ${agent.index} custody=${agent.custody ?? "?"}`);

  const active = await waitFor("agent active", async () => {
    const s = await api.get(`/agents/${agent.id}/status`);
    if (s.json.agentStatus === "failed" || s.json.status === "error") throw Object.assign(new Error(`create job failed: ${s.json.error?.message ?? ""}`), { fatal: true });
    return s.json.agentStatus === "active" ? s.json : null;
  }, { timeoutMs: 10 * 60_000, intervalMs: 3000 });
  for (const s of active.steps as Array<{ id: string; txHash?: string }>) if (s.txHash) say(`  tx ${s.id}: ${s.txHash}`);

  const put = await api.put(`/agents/${agent.id}/send-policy`, { policy: "allowlist", allow: [ALLOW], limit: 10 });
  if (put.status !== 202) throw new Error(`PUT send-policy ${put.status} ${put.json?.error ?? ""}`);
  const pjob = await job(agent.id, "policy");
  for (const s of pjob.steps as Array<{ id: string; txHash?: string }>) if (s.txHash) say(`  tx ${s.id}: ${s.txHash}`);

  const ens = readOnlyEns(env.sepoliaRpc);
  const r = await waitFor("ENS records", async () => {
    const x = await ens.resolveAgent(agent.ensName);
    return x.sendPolicy && x.signer ? x : null;
  }, { timeoutMs: 120_000, intervalMs: 4000 });
  say(`ENS resolved: ${JSON.stringify(r)}`.replace(/"pubkey":"[^"]*"/, '"pubkey":"<omitted>"'));
  say(`signer equals keygen address: ${r.signer?.toLowerCase() === signerAddress.toLowerCase()}`);

  // Server must not decrypt for a self-custody agent.
  const t = { token };
  const me2 = await api.get("/v1/me", t);
  say(`GET /v1/me -> ${me2.status} custody=${me2.json?.custody ?? me2.json?.agent?.custody ?? "?"}`);
  const inbox = await api.get("/v1/inbox", t);
  say(`GET /v1/inbox (no raw) -> ${inbox.status} ${inbox.json?.error ?? ""}`);
  const raw = await api.get("/v1/inbox?raw=1", t);
  say(`GET /v1/inbox?raw=1 -> ${raw.status} (items ${Array.isArray(raw.json?.items) ? raw.json.items.length : "n/a"})`);
  const otp = await api.get("/v1/otp/latest", t);
  say(`GET /v1/otp/latest -> ${otp.status} ${otp.json?.error ?? ""}`);
  const mcp = await api.request("POST", "/mcp", {
    token,
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "check", version: "0" } } },
  });
  say(`POST /mcp -> ${mcp.status} ${mcp.json?.error ?? ""}`);
  process.exit(0);
} catch (e) {
  console.error(`failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
  process.exit(1);
}
