// STEP 10a: operator deploys a PermissionedResolver proxy via VerifiableFactory with initial records. Idempotent.
import { encodeFunctionData, getAddress } from "viem";
import { abis, client, operator, simSend, record, FACTORY, RESOLVER_IMPL, SALT, PREDICTED_RESOLVER, TEST_USER, AGENT0, DNS_NAME, RS } from "./lib";

const predicted = getAddress((await client.readContract({ address: FACTORY, abi: abis.factory, functionName: "predictProxyAddress", args: [operator.address, SALT] })) as string);
console.log(`predicted=${predicted} expected=${PREDICTED_RESOLVER} match=${predicted === PREDICTED_RESOLVER}`);
if (predicted !== PREDICTED_RESOLVER) { console.log("MISMATCH, stopping"); process.exit(1); }

const code = await client.getCode({ address: predicted });
if (code && code !== "0x") { console.log("resolver proxy already deployed, skipping"); process.exit(0); }

// Resolver roles on ROOT: SET_TEXT, SET_ADDRESS and their admin roles (<<128). No UPGRADE.
const set = RS("ROLE_SET_TEXT") | RS("ROLE_SET_ADDRESS");
const roleBitmap = set | (set << 128n);
const grants = [{ account: operator.address, roleBitmap }, { account: TEST_USER, roleBitmap }];
const R = abis.resolver;
const text = (key: string, value: string) => encodeFunctionData({ abi: R, functionName: "setText", args: [DNS_NAME, key, value] });
const calls = [
  encodeFunctionData({ abi: R, functionName: "setAddress", args: [DNS_NAME, 60n, AGENT0] }),
  text("email", "t04test@nanite.test"),
  text("nanite.pubkey", "placeholder-x25519-pubkey"),
  text("agent-context", "initial context"),
];
const data = encodeFunctionData({ abi: R, functionName: "initialize", args: [grants, calls] });
console.log(`roleBitmap=0x${roleBitmap.toString(16)}`);

const { rc } = await simSend("resolverDeploy", operator, { address: FACTORY, abi: abis.factory, functionName: "deployProxy", args: [RESOLVER_IMPL, SALT, data] });
const after = await client.getCode({ address: predicted });
console.log(`code at predicted: ${after && after !== "0x" ? "present" : "MISSING"}`);
record("resolverProxy", { address: predicted, matchesPrediction: true, salt: SALT.toString(), deployBlock: Number(rc.blockNumber) });
