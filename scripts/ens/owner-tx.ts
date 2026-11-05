// Builds owner transactions for the signing page. Never sends anything and never touches a private key.
// Usage: tsx scripts/ens/owner-tx.ts <deploy-user-registry|set-subregistry|set-parent|grant-operator|all> [operatorAddress]
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import {
  createPublicClient, http, encodeFunctionData, encodeAbiParameters, keccak256, toHex, getCreate2Address,
  concatHex, parseAbi, type Abi, type Address, type Hex, isAddress, getAddress, hexToBigInt, pad, stringToBytes,
} from "viem";
import { sepolia } from "viem/chains";

const readJson = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const cfg = readJson("../../config/sepolia.json");
const roles = readJson("../../config/roles.json");
const abi = (n: string): Abi => readJson(`../../contracts/abi/${n}.json`);

const OWNER = getAddress(cfg.owner) as Address;
const C = Object.fromEntries(Object.entries(cfg.contracts).map(([k, v]) => [k, getAddress(v as string)])) as Record<string, Address>;
const ALL_ROLES = BigInt(roles.ALL_ROLES);
const ROLE_REGISTRAR = BigInt(roles.registry.ROLE_REGISTRAR);
const ROLE_RENEW = BigInt(roles.registry.ROLE_RENEW);
const LABEL = "nanitecom";
export const SALT_LABEL = "nanitecom.eth/user-registry/v1";
export const SALT = hexToBigInt(keccak256(toHex(SALT_LABEL)));
const rpc = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const client = createPublicClient({ chain: sepolia, transport: http(rpc) });

interface OwnerTx { step: string; description: string; chainId: number; from: Address; to: Address; value: "0"; data: Hex; decoded: Record<string, unknown>; notes?: string[] }

/** Off-chain CREATE2 prediction replicating VerifiableFactory (EIP-1167 clone + appended salt). */
function predictProxy(deployer: Address, salt: bigint): Address {
  const outerSalt = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [deployer, salt]));
  const logic = proxyLogicCache!;
  // creation code: 0x3d604d80600a3d3981f3 + 363d3d373d3d3d363d73 + logic + 5af43d82803e903d91602b57fd5bf3 + salt
  const code = concatHex(["0x3d604d80600a3d3981f3363d3d373d3d3d363d73", logic, "0x5af43d82803e903d91602b57fd5bf3", outerSalt]);
  return getCreate2Address({ from: C.VerifiableFactory, salt: outerSalt, bytecodeHash: keccak256(code) });
}
let proxyLogicCache: Address | undefined;

async function main() {
  const step = process.argv[2];
  const operator = process.argv[3];
  const steps = ["deploy-user-registry", "set-subregistry", "set-parent", "grant-operator"];
  const todo = step === "all" ? steps : [step];
  if (!todo.every((s) => steps.includes(s))) throw new Error(`step must be one of ${steps.join(", ")}, all`);

  proxyLogicCache = (await client.readContract({ address: C.VerifiableFactory, abi: abi("VerifiableFactory"), functionName: "proxyLogic" })) as Address;
  const predicted = predictProxy(OWNER, SALT);
  const onchain = (await client.readContract({ address: C.VerifiableFactory, abi: abi("VerifiableFactory"), functionName: "predictProxyAddress", args: [OWNER, SALT] })) as Address;
  console.log(`salt label      : ${SALT_LABEL}`);
  console.log(`salt (uint256)  : ${SALT}`);
  console.log(`predicted proxy : ${predicted} (off-chain CREATE2)`);
  console.log(`factory predict : ${onchain} ${predicted.toLowerCase() === onchain.toLowerCase() ? "MATCH" : "MISMATCH !!!"}`);

  mkdirSync(new URL("../../signer/txs/", import.meta.url), { recursive: true });
  for (const s of todo) {
    let tx: OwnerTx;
    if (s === "deploy-user-registry") {
      const grants = [{ account: OWNER, roleBitmap: ALL_ROLES }];
      const initData = encodeFunctionData({ abi: abi("UserRegistryImpl"), functionName: "initialize", args: [grants] });
      const data = encodeFunctionData({ abi: abi("VerifiableFactory"), functionName: "deployProxy", args: [C.UserRegistryImpl, SALT, initData] });
      tx = { step: s, description: "Deploy the nanitecom.eth UserRegistry proxy via VerifiableFactory (owner gets ALL_ROLES on root)", chainId: 11155111, from: OWNER, to: C.VerifiableFactory, value: "0", data,
        decoded: { function: "deployProxy(address,uint256,bytes)", implementation: C.UserRegistryImpl, salt: SALT.toString(), saltLabel: SALT_LABEL, initialize: { function: "initialize((address,uint256)[])", grants: [{ account: OWNER, roleBitmap: roles.ALL_ROLES }] }, predictedProxy: predicted } };
    } else if (s === "set-subregistry") {
      const anyId = BigInt(keccak256(stringToBytes(LABEL)));
      const data = encodeFunctionData({ abi: abi("ETHRegistry"), functionName: "setSubregistry", args: [anyId, predicted] });
      tx = { step: s, description: `ETHRegistry.setSubregistry("${LABEL}", predicted UserRegistry proxy)`, chainId: 11155111, from: OWNER, to: C.ETHRegistry, value: "0", data,
        decoded: { function: "setSubregistry(uint256,address)", anyId: anyId.toString(), anyIdHex: toHex(anyId, { size: 32 }), label: LABEL, registry: predicted } };
    } else if (s === "set-parent") {
      const data = encodeFunctionData({ abi: abi("UserRegistryImpl"), functionName: "setParent", args: [C.ETHRegistry, LABEL] });
      tx = { step: s, description: `UserRegistry proxy.setParent(ETHRegistry, "${LABEL}")`, chainId: 11155111, from: OWNER, to: predicted, value: "0", data,
        decoded: { function: "setParent(address,string)", parent: C.ETHRegistry, label: LABEL }, notes: ["Requires step deploy-user-registry to be mined first"] };
    } else {
      if (!operator || !isAddress(operator)) throw new Error("grant-operator needs an operator address as 2nd arg");
      const bitmap = ROLE_REGISTRAR | ROLE_RENEW;
      const data = encodeFunctionData({ abi: abi("UserRegistryImpl"), functionName: "grantRootRoles", args: [bitmap, getAddress(operator)] });
      tx = { step: s, description: "UserRegistry proxy.grantRootRoles(ROLE_REGISTRAR | ROLE_RENEW, operator)", chainId: 11155111, from: OWNER, to: predicted, value: "0", data,
        decoded: { function: "grantRootRoles(uint256,address)", roleBitmap: toHex(bitmap), roles: ["ROLE_REGISTRAR", "ROLE_RENEW"], account: getAddress(operator) }, notes: ["Requires step deploy-user-registry to be mined first"] };
    }
    writeFileSync(new URL(`../../signer/txs/${s}.json`, import.meta.url), JSON.stringify(tx, null, 2) + "\n");
    console.log(`\n[${s}] -> signer/txs/${s}.json  to=${tx.to}`);
    await simulate(tx, predicted);
  }
  const dir = new URL("../../signer/txs/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json").sort();
  writeFileSync(new URL("index.json", dir), JSON.stringify(files, null, 2) + "\n");
}

async function simulate(tx: OwnerTx, predicted: Address) {
  try {
    if (tx.step === "deploy-user-registry" || tx.step === "set-subregistry") {
      if (tx.step === "set-subregistry") {
        // Does the owner hold ROLE_SET_SUBREGISTRY on the nanitecom token (and does the name exist)?
        const anyId = BigInt(keccak256(stringToBytes(LABEL)));
        const st: any = await client.readContract({ address: C.ETHRegistry, abi: abi("ETHRegistry"), functionName: "getState", args: [anyId] });
        console.log("  state:", { status: st.status, expiry: st.expiry.toString(), latestOwner: st.latestOwner, tokenId: toHex(st.tokenId, { size: 32 }), resource: toHex(st.resource, { size: 32 }) });
        const r = await client.readContract({ address: C.ETHRegistry, abi: abi("ETHRegistry"), functionName: "roles", args: [anyId, OWNER] });
        console.log("  owner roles on name resource:", toHex(r as bigint));
      }
      await client.call({ account: OWNER, to: tx.to, data: tx.data });
      console.log("  simulation (eth_call from owner): OK");
    } else {
      // Needs the proxy deployed. If not, use state overrides is not feasible for a clone; skip.
      const code = await client.getCode({ address: predicted });
      if (!code) { console.log("  simulation SKIPPED: proxy not deployed yet (run after deploy-user-registry is mined)"); return; }
      await client.call({ account: OWNER, to: tx.to, data: tx.data });
      console.log("  simulation (eth_call from owner): OK");
    }
  } catch (e: any) {
    console.log("  simulation FAILED:", (e.shortMessage ?? e.message ?? String(e)).split("\n")[0], e.data ?? e.cause?.data ?? "");
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
