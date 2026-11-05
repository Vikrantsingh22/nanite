// SIMULATION ONLY (eth_call). Sends no transactions. Step 8 of T0.4.
// Simulates register() on the nanitecom UserRegistry proxy from the operator (and from a non-operator address).
import { readFileSync } from "node:fs";
import { createPublicClient, http, keccak256, toBytes, zeroAddress, BaseError, ContractFunctionRevertedError, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const load = (f: string) => JSON.parse(readFileSync(new URL(`../../contracts/abi/${f}`, import.meta.url), "utf8"));
const roles = JSON.parse(readFileSync(new URL("../../config/roles.json", import.meta.url), "utf8")).registry as Record<string, string>;
const R = (k: string) => BigInt(roles[k]);

const PROXY: Address = "0xD2BE04253E815972D6a1D995670eBAc7a6C8C786";
const ETH_REGISTRY: Address = "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4";
const TEST_USER: Address = "0xfAD31e74F1Cb69046BBB2e4A15ce653beE6936C0";
const AGENT0: Address = "0xC0575045B1acacC1349e3e5f8bE20FBA3a8E287b";
const abi = load("UserRegistryImpl.json");

const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
const operator = privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
const label = process.argv[2] ?? "t04test";

// abi is loaded untyped, so the result type is not inferred; narrow at runtime.
const fmtId = (v: unknown): string => (typeof v === "bigint" ? `0x${v.toString(16)}` : String(v));

async function sim(name: string, account: Address, args: { label: string; owner: Address; expiry: bigint; roleBitmap: bigint }) {
  try {
    const r = await client.simulateContract({
      address: PROXY, abi, functionName: "register", account,
      args: [args.label, args.owner, zeroAddress, zeroAddress, args.roleBitmap, args.expiry],
    });
    console.log(`${name}: OK (would succeed) tokenId=${fmtId(r.result)} roleBitmap=0x${args.roleBitmap.toString(16)} expiry=${args.expiry}`);
  } catch (e) {
    let msg = "";
    if (e instanceof BaseError) {
      const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
      msg = rev ? `${rev.data?.errorName ?? rev.reason ?? "revert"}(${(rev.data?.args ?? []).map(String).join(", ")})` : e.shortMessage;
    } else msg = String(e);
    console.log(`${name}: REVERT ${msg}`);
  }
}

const block = await client.getBlock();
const now = block.timestamp;
const parent = (await client.readContract({ address: ETH_REGISTRY, abi: load("ETHRegistry.json"), functionName: "getState", args: [BigInt(keccak256(toBytes("nanitecom")))] })) as { expiry: bigint };
const state = (await client.readContract({ address: PROXY, abi, functionName: "getState", args: [BigInt(keccak256(toBytes(label)))] })) as { status: number; expiry: bigint };
console.log(`chain=${await client.getChainId()} operator=${operator.address} now=${now} parentExpiry=${parent.expiry}`);
console.log(`getState(${label}): status=${state.status} (0=AVAILABLE) expiry=${state.expiry}`);
console.log(`operator hasRootRoles REGISTRAR|RENEW: ${await client.readContract({ address: PROXY, abi, functionName: "hasRootRoles", args: [R("ROLE_REGISTRAR") | R("ROLE_RENEW"), operator.address] })}`);
console.log(`operator hasRootRoles SET_RESOLVER: ${await client.readContract({ address: PROXY, abi, functionName: "hasRootRoles", args: [R("ROLE_SET_RESOLVER"), operator.address] })}`);
if (state.status !== 0) { console.log("label not available; aborting"); process.exit(1); }

const d30 = now + 30n * 86400n;
const base = { label, owner: TEST_USER, expiry: d30, roleBitmap: 0n };
const userRoles = R("ROLE_SET_RESOLVER") | R("ROLE_SET_SUBREGISTRY");
const userRolesAdmin = userRoles | (userRoles << 128n);

await sim("A baseline (30d, bitmap 0)", operator.address, base);
await sim("B expiry = parent + 1y", operator.address, { ...base, expiry: parent.expiry + 31536000n });
await sim("B2 expiry = parent + 1s", operator.address, { ...base, expiry: parent.expiry + 1n });
await sim("C past expiry (now-1)", operator.address, { ...base, expiry: now - 1n });
await sim("D1 SET_RESOLVER|SET_SUBREGISTRY", operator.address, { ...base, roleBitmap: userRoles });
await sim("D2 D1 + admin roles (<<128)", operator.address, { ...base, roleBitmap: userRolesAdmin });
await sim("D3 D2 + CAN_TRANSFER_ADMIN", operator.address, { ...base, roleBitmap: userRolesAdmin | R("ROLE_CAN_TRANSFER_ADMIN") });
await sim("D4 ALL_ROLES (for contrast)", operator.address, { ...base, roleBitmap: BigInt(JSON.parse(readFileSync(new URL("../../config/roles.json", import.meta.url), "utf8")).ALL_ROLES) });
await sim("E reserve (owner=0, bitmap 0)", operator.address, { ...base, owner: zeroAddress });
await sim("E2 owner=0, bitmap!=0", operator.address, { ...base, owner: zeroAddress, roleBitmap: userRoles });
await sim("F non-operator (agent 0)", AGENT0, base);
