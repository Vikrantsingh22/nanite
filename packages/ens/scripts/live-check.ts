// Opt-in live integration check on Sepolia. SENDS REAL TRANSACTIONS (operator pays gas).
// Usage: docker compose run --rm tools npx tsx packages/ens/scripts/live-check.ts --yes
// Idempotent: re-running skips every step already done on-chain.
import { formatEther, keccak256, toBytes, type Address } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { abis, AGENT_SETTER_KEYS, createEnsServiceFromConfig, createPublicEnsClient, dnsEncode, errText, loadEnsConfig, SEND_KEYS } from "../src/index.js";

if (!process.argv.includes("--yes")) {
  console.log("live-check sends real Sepolia transactions. Re-run with --yes to proceed.");
  process.exit(0);
}

const USERNAME = "t21test";
const AGENT_LABEL = "alex";
const TEST_USER: Address = "0xfAD31e74F1Cb69046BBB2e4A15ce653beE6936C0";
const config = loadEnsConfig();
const svc = createEnsServiceFromConfig(config);
const client = createPublicEnsClient(config);
const agent0 = mnemonicToAccount(process.env.TEST_SEED_MNEMONIC as string, { addressIndex: 0 });
const name = svc.fullName(USERNAME, AGENT_LABEL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (title: string, v: unknown) =>
  console.log(`\n== ${title}\n${JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2)}`);

const operator = privateKeyToAccount(config.operatorPrivateKey).address;
const balBefore = await client.getBalance({ address: operator });

const user = await svc.createUserName({ username: USERNAME, userWallet: TEST_USER });
show("createUserName", user);

const pubkey = keccak256(toBytes(`nanite:live-check:${name}`)).slice(2); // stand-in X25519 key (32 bytes hex)
const agent = await svc.createAgentName({
  username: USERNAME,
  agentLabel: AGENT_LABEL,
  agentWallet: agent0.address,
  email: `${AGENT_LABEL}.${USERNAME}@nanite.test`,
  encryptionPublicKeyHex: pubkey,
});
show("createAgentName", agent);

// Public RPC can serve stale reads right after a receipt: poll until the name resolves.
let resolved = await svc.resolveAgent(name);
for (let i = 0; i < 20 && !resolved.address; i++) {
  await sleep(3000);
  resolved = await svc.resolveAgent(name);
}
show("resolveAgent", resolved);

const resolver = agent.resolver;
const dns = dnsEncode(name);
const sim = async (fn: string, args: unknown[], account: Address) => {
  try {
    await client.simulateContract({ address: resolver, abi: abis.resolver, functionName: fn, args, account } as never);
    return "OK";
  } catch (e) {
    return `REVERT ${errText(e)}`;
  }
};
const checks: Record<string, string> = {};
// Stale-read tolerance: the node may not see the grant receipt yet, so poll the positive check.
checks["agent0 setText(agent-context)"] = await sim("setText", [dns, "agent-context", "hello from alex"], agent0.address);
for (let i = 0; i < 10 && checks["agent0 setText(agent-context)"] !== "OK"; i++) {
  await sleep(3000);
  checks["agent0 setText(agent-context)"] = await sim("setText", [dns, "agent-context", "hello from alex"], agent0.address);
}
checks["agent0 setText(nanite.send)"] = await sim("setText", [dns, SEND_KEYS.policy, "any"], agent0.address);
checks["agent0 setText(email)"] = await sim("setText", [dns, "email", "evil@x.test"], agent0.address);
show("agent permission simulations (before revoke)", checks);

const policy = await svc.setSendPolicy({ username: USERNAME, agentLabel: AGENT_LABEL, policy: "allowlist", allow: ["friend@example.com"] });
show("setSendPolicy", policy);
let sp = await svc.readSendPolicy(name);
for (let i = 0; i < 20 && sp.policy !== "allowlist"; i++) {
  await sleep(3000);
  sp = await svc.readSendPolicy(name);
}
show("readSendPolicy", sp);

const revoke = await svc.revokeAgent({ username: USERNAME, agentLabel: AGENT_LABEL });
show("revokeAgent (no unregister)", revoke);
await sleep(4000);
const after: Record<string, string> = {};
for (const k of AGENT_SETTER_KEYS) after[`agent0 setText(${k})`] = await sim("setText", [dns, k, "x"], agent0.address);
after["agent0 setText(nanite.send)"] = await sim("setText", [dns, SEND_KEYS.policy, "any"], agent0.address);
show("agent permission simulations (after revoke)", after);

// Prove the operator holds the right to unregister (simulation only, nothing sent).
try {
  await client.simulateContract({
    address: user.registry,
    abi: abis.userRegistry,
    functionName: "unregister",
    args: [BigInt(keccak256(toBytes(AGENT_LABEL)))],
    account: operator,
  } as never);
  console.log("\noperator unregister(alex) simulation: OK");
} catch (e) {
  console.log(`\noperator unregister(alex) simulation: REVERT ${errText(e)}`);
}

const balAfter = await client.getBalance({ address: operator });
console.log(`\noperator spent ${formatEther(balBefore - balAfter)} ETH this run (balance ${formatEther(balAfter)})`);
