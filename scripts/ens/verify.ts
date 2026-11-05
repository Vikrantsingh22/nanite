// STEP 11: verify resolution via UniversalResolverV2, agent-0 write, and expected reverts (simulated only).
// Usage: docker compose run --rm tools npx tsx scripts/ens/verify.ts [--write]
//   default : read-only. All reads and negative simulations run; the agent-0 setText is only SIMULATED (no tx sent).
//   --write : additionally SENDS the real agent-0 setText transaction.
import { encodeFunctionData } from "viem";
import { abis, client, agent, simSend, record, errText, NAME, DNS_NAME, AGENT0, PREDICTED_RESOLVER, UR_V2 } from "./lib";

const opts = { universalResolverAddress: UR_V2 } as const;
const read = async () => ({
  addr: await client.getEnsAddress({ name: NAME, ...opts }),
  email: await client.getEnsText({ name: NAME, key: "email", ...opts }),
  pubkey: await client.getEnsText({ name: NAME, key: "nanite.pubkey", ...opts }),
  ctx: await client.getEnsText({ name: NAME, key: "agent-context", ...opts }),
});
const before = await read();
console.log("before:", before);

const a0 = agent(0); const a1 = agent(1);
if (a0.address !== AGENT0) { console.log("agent0 address mismatch"); process.exit(1); }
const value = `updated by agent 0 at ${new Date().toISOString()}`;
const R = { address: PREDICTED_RESOLVER, abi: abis.resolver } as const;
const WRITE = process.argv.includes("--write");
const setTextReq = { ...R, functionName: "setText", args: [DNS_NAME, "agent-context", value] } as const;
if (WRITE) {
  await simSend("agent0SetText", a0, setTextReq, { value });
} else {
  try { await client.simulateContract({ ...setTextReq, account: a0 }); console.log("agent0SetText: simulation OK (read-only mode, NOT sent; pass --write to send)"); }
  catch (e) { console.log(`agent0SetText: SIMULATION FAILED: ${errText(e)}`); process.exit(1); }
}
const after = await read();
console.log("after:", after);

const neg: Record<string, string> = {};
const trySim = async (k: string, account: any, functionName: string, args: any[]) => {
  try { await client.simulateContract({ ...R, functionName, args, account }); neg[k] = "UNEXPECTED SUCCESS"; }
  catch (e) { neg[k] = errText(e); }
  console.log(`${k}: ${neg[k]}`);
};
await trySim("agent0 setText(email)", a0, "setText", [DNS_NAME, "email", "evil@x.test"]);
await trySim("agent0 setAddress(60)", a0, "setAddress", [DNS_NAME, 60n, a0.address]);
await trySim("agent1 setText(agent-context)", a1, "setText", [DNS_NAME, "agent-context", "x"]);
if (WRITE) record("verification", { before, after, wroteValue: value, negativeSimulations: neg });
