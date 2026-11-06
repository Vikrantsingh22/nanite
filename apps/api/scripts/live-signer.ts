/*
 * LIVE check of verifiable outbound mail (signing option B), against the demo user's agent on real Sepolia.
 * No real email: the API must run with FAKE_RESEND_SEND=1 and DEV_ROUTES=1 (the fake provider keeps the outbound
 * headers in memory and GET /internal/dev/outbox returns them; From + headers only, never subject/body/recipient).
 *
 *   docker compose run --rm -e API_URL=http://nanite-api-live:4000 tools npx tsx apps/api/scripts/live-signer.ts [--agent=alex]
 *
 * Steps: (0) operator balance >= 0.05 ETH, (1) sign in as the test user, (2) POST /agents/:id/signer and wait for
 * the publish-signer tx, (3) resolve `nanite.signer` through UniversalResolverV2, (4) rotate the agent token and send
 * through /v1/emails/send to a recipient the policy already allows, (5) take the headers from the fake provider and
 * verify with the CLI against LIVE ENS (and once more with a tampered subject, which must fail).
 * Prints only step results, addresses, tx hashes and the verifier's verdict. Appends a section to LIVE-E2E.md.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiClient, MIN_OPERATOR_ETH, loadLiveEnv, operatorBalanceEth, readOnlyEns, siweLogin, txLink, userAccount, waitFor } from "./lib/live.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const env = loadLiveEnv({ ...process.env, ...(arg("api") ? { API_URL: arg("api") } : {}) });
const api = new ApiClient(env.apiUrl, env.webOrigin);
const DOC = fileURLToPath(new URL("../LIVE-E2E.md", import.meta.url));
const CLI = fileURLToPath(new URL("./verify-mail-signature.ts", import.meta.url));
const agentName = arg("agent") ?? "alex";
const say = (l: string) => console.log(l);
const must = (c: unknown, m: string) => {
  if (!c) throw new Error(m);
};
// The seeded conversation of alex is from this sender, so the default reply-only policy allows replying to it.
const RECIPIENT = "dana@whitfield-studio.example";
const SUBJECT = "Re: Quick question about the onboarding draft (live signing check)";
const BODY = "Invented text for the live signing check.\nSecond line, with unicode: ünï.\n";

const lines: string[] = [];
let ok = false;
let balance0: number | undefined;
let balance1: number | undefined;
try {
  const bal = await operatorBalanceEth(env);
  must(bal, "OPERATOR_PRIVATE_KEY missing: cannot check the gas balance");
  balance0 = bal!.eth;
  must(bal!.eth >= MIN_OPERATOR_ETH, `operator balance ${bal!.eth.toFixed(4)} ETH is below ${MIN_OPERATOR_ETH}: stop`);
  say(`[0] operator ${bal!.address} has ${bal!.eth.toFixed(4)} ETH`);

  const me = await siweLogin(api, userAccount(env), env.webOrigin);
  must(me.username, "test user has no username in this database (use nanite_live, see LIVE-E2E.md)");
  const list = await api.get("/agents");
  const agent = (list.json.agents as any[]).find((a) => a.name === agentName && a.status === "active");
  must(agent, `no active agent "${agentName}" for ${me.username}`);
  say(`[1] signed in as ${me.username}; agent ${agent.ensName}`);

  const before = await api.get(`/agents/${agent.id}/signer`);
  say(`    signer before: address=${before.json.address ?? "none"} record=${before.json.record}`);
  const post = await api.post(`/agents/${agent.id}/signer`);
  must(post.status === 202, `POST /signer answered ${post.status} ${post.json?.error ?? ""}`);
  const signerAddress: string = post.json.signerAddress;
  const job = await waitFor("signer job", async () => {
    const s = await api.get(`/agents/${agent.id}/status`);
    if (s.json.kind === "signer" && s.json.status === "error") throw Object.assign(new Error(`signer job failed: ${s.json.error?.message ?? ""}`), { fatal: true });
    return s.json.kind === "signer" && s.json.status === "done" ? s.json : null;
  }, { timeoutMs: 5 * 60_000, intervalMs: 3000 });
  const tx = (job.steps as Array<{ id: string; txHash?: string }>).find((s) => s.id === "publish-signer")?.txHash;
  must(tx, "publish-signer produced no tx hash");
  say(`[2] publish-signer tx ${tx}; signer ${signerAddress}`);

  const ens = readOnlyEns(env.sepoliaRpc);
  const resolved = await waitFor("nanite.signer on ENS", async () => {
    const r = await ens.resolveAgent(agent.ensName);
    return r.signer?.toLowerCase() === signerAddress.toLowerCase() ? r : null;
  }, { timeoutMs: 120_000, intervalMs: 3000 });
  say(`[3] UniversalResolverV2: ${agent.ensName} nanite.signer = ${resolved.signer}`);
  const info = await api.get(`/agents/${agent.id}/signer`);
  must(info.json.record === "published", `GET /signer says ${info.json.record}`);

  const rot = await api.post(`/agents/${agent.id}/token`);
  must(rot.status === 201, `token rotation answered ${rot.status}`);
  const token: string = rot.json.token;
  const sent = await api.post("/v1/emails/send", { to: RECIPIENT, subject: SUBJECT, body: BODY }, { token });
  must(sent.status === 200, `send answered ${sent.status} ${sent.json?.error ?? ""}`);
  must(/^fake-sent-/.test(sent.json.providerMessageId), "provider is not the FAKE provider: stop (no real mail may be sent)");
  must(sent.json.signature === "signed", `send says signature=${sent.json.signature}`);
  say(`[4] sent via the fake provider: signature=${sent.json.signature}`);

  const outbox = await api.get("/internal/dev/outbox?limit=1", { session: false });
  must(outbox.status === 200 && outbox.json.items?.length === 1, `GET /internal/dev/outbox answered ${outbox.status} (needs DEV_ROUTES=1 and FAKE_RESEND_SEND=1)`);
  const { from, headers } = outbox.json.items[0] as { from: string; headers: Record<string, string> };
  must(headers["X-Nanite-Sig-Version"] === "3" && headers["X-Nanite-Signature"] && headers["X-Nanite-Message-Id"], "outbound headers carry no v3 signature");
  say(`    headers: ${Object.keys(headers).sort().join(", ")}`);

  const dir = mkdtempSync(join(tmpdir(), "nanite-sig-"));
  try {
    const run = (subject: string) => {
      const file = join(dir, "mail.json");
      writeFileSync(file, JSON.stringify({ headers, from, to: RECIPIENT, subject, body: BODY }));
      const r = spawnSync(process.execPath, ["--import", "tsx", CLI, file, `--rpc=${env.sepoliaRpc}`], { encoding: "utf8" });
      return { code: r.status, out: (r.stdout ?? "").trim() };
    };
    const good = run(SUBJECT);
    say(`[5] CLI verdict (exit ${good.code}):\n${good.out}`);
    const verdict = JSON.parse(good.out) as { valid: boolean; agent: string; signer: string; reason: string };
    must(good.code === 0 && verdict.valid && verdict.signer.toLowerCase() === signerAddress.toLowerCase(), "verification failed");
    const bad = run(SUBJECT + " (tampered)");
    const badV = JSON.parse(bad.out) as { valid: boolean; reason: string };
    must(bad.code === 1 && !badV.valid && badV.reason === "signer_mismatch", "tampered subject was not rejected");
    say(`    tampered subject: exit ${bad.code}, reason=${badV.reason}`);

    const end = await operatorBalanceEth(env);
    balance1 = end?.eth;
    lines.push(
      "",
      `## Verifiable outbound mail, live check ${new Date().toISOString()} (signing option B)`,
      "",
      `- Agent \`${agent.ensName}\` (demo user \`${me.username}\`, database \`nanite_live\`), API \`${env.apiUrl}\`, fake mail provider (no real email).`,
      `- Operator balance ${balance0?.toFixed(4)} -> ${balance1?.toFixed(4) ?? "?"} ETH.`,
      `- \`POST /agents/:id/signer\` -> job \`publish-signer\`: tx [\`${tx}\`](${txLink(tx!)}); signer address \`${signerAddress}\`.`,
      `- UniversalResolverV2: \`${agent.ensName}\` text \`nanite.signer\` = \`${resolved.signer}\`.`,
      `- \`POST /v1/emails/send\` (to a recipient the reply-only policy allows) -> \`signature: "signed"\`; outbound headers captured from the fake provider: ${Object.keys(headers).sort().map((h) => `\`${h}\``).join(", ")}.`,
      `- \`verify-mail-signature.ts\` against LIVE ENS: exit ${good.code}, \`${JSON.stringify(verdict)}\`.`,
      `- Same mail with a tampered subject: exit ${bad.code}, reason \`${badV.reason}\`.`,
      "",
    );
    ok = true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} catch (e) {
  const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  say(`FAILED: ${msg}`);
  lines.push("", `## Verifiable outbound mail, live check ${new Date().toISOString()} (FAILED)`, "", `- ${msg}`, "");
}
appendFileSync(DOC, lines.join("\n"));
say(ok ? "ALL STEPS PASSED (appended to apps/api/LIVE-E2E.md)" : "FAILED (appended to apps/api/LIVE-E2E.md)");
process.exit(ok ? 0 : 1);
