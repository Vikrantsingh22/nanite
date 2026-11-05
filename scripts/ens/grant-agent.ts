// STEP 10b: operator grants agent 0 key-scoped setText("agent-context") on the resolver. Idempotent.
import { encodeFunctionData } from "viem";
import { abis, client, operator, simSend, record, AGENT0, DNS_NAME, PREDICTED_RESOLVER, RS } from "./lib";
import { keccak256, toBytes } from "viem";

const resource = BigInt(keccak256(toBytes("agent-context"))); // PermissionedResolverLib.resource(key)
const has = await client.readContract({ address: PREDICTED_RESOLVER, abi: abis.resolver, functionName: "hasRoles", args: [resource, RS("ROLE_SET_TEXT"), AGENT0] });
if (has) { console.log("agent 0 already has key-scoped SET_TEXT, skipping"); }
else {
  const setter = encodeFunctionData({ abi: abis.resolver, functionName: "setText", args: [DNS_NAME, "agent-context", ""] });
  await simSend("grantSetterRoles", operator, { address: PREDICTED_RESOLVER, abi: abis.resolver, functionName: "grantSetterRoles", args: [setter, AGENT0] }, { resource: "0x" + resource.toString(16) });
}
const roles = async (r: bigint) => "0x" + ((await client.readContract({ address: PREDICTED_RESOLVER, abi: abis.resolver, functionName: "roles", args: [r, AGENT0] })) as bigint).toString(16);
console.log("agent0 roles on key resource:", await roles(resource), " on ROOT:", await roles(0n));
