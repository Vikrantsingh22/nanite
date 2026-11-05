// STEP 9: operator registers t04test.nanitecom.eth to the test user with the agent resolver. Idempotent.
import { zeroAddress } from "viem";
import { abis, client, operator, simSend, record, PROXY, LABEL, TEST_USER, PREDICTED_RESOLVER, PARENT_EXPIRY } from "./lib";
import { keccak256, toBytes } from "viem";

const id = BigInt(keccak256(toBytes(LABEL)));
const st = async () => (await client.readContract({ address: PROXY, abi: abis.registry, functionName: "getState", args: [id] })) as any;
const code = await client.getCode({ address: PREDICTED_RESOLVER });
if (!code || code === "0x") { console.log("resolver not deployed; run deploy-agent-resolver.ts first"); process.exit(1); }

let s = await st();
if (s.status !== 0) { console.log(`label status=${s.status}, skipping register`); }
else {
  const now = (await client.getBlock()).timestamp;
  const expiry = [now + 30n * 86400n, PARENT_EXPIRY].reduce((a, b) => (a < b ? a : b));
  if (expiry <= now) { console.log("expiry <= now, stopping"); process.exit(1); }
  // D3: SET_RESOLVER|SET_SUBREGISTRY + admin roles + CAN_TRANSFER_ADMIN (same bitmap the owner holds on nanitecom)
  const roleBitmap = 0x1110000000000000000000000000000001100000n;
  await simSend("register", operator, { address: PROXY, abi: abis.registry, functionName: "register", args: [LABEL, TEST_USER, zeroAddress, PREDICTED_RESOLVER, roleBitmap, expiry] }, { label: LABEL, expiry: Number(expiry), roleBitmap: "0x" + roleBitmap.toString(16) });
  s = await st();
}
const roles = await client.readContract({ address: PROXY, abi: abis.registry, functionName: "roles", args: [s.resource, TEST_USER] });
const res = await client.readContract({ address: PROXY, abi: abis.registry, functionName: "getResolver", args: [LABEL] }).catch((e) => `getResolver n/a`);
const out = { status: s.status, expiry: Number(s.expiry), latestOwner: s.latestOwner, tokenId: "0x" + s.tokenId.toString(16), resource: "0x" + s.resource.toString(16), userRoles: "0x" + (roles as bigint).toString(16), resolver: res };
console.log("getState:", out);
record("registeredState", out);
