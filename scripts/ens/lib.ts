// Shared helpers for T0.4 steps 10a/9/10b/11 (Sepolia, operator + agent wallets). Never logs keys.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  createPublicClient, createWalletClient, http, keccak256, toBytes, toHex, BaseError, ContractFunctionRevertedError,
  type Address, type Hex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { packetToBytes } from "viem/ens";
import { sepolia } from "viem/chains";

export const load = (f: string) => JSON.parse(readFileSync(new URL(`../../contracts/abi/${f}`, import.meta.url), "utf8"));
const rolesJson = JSON.parse(readFileSync(new URL("../../config/roles.json", import.meta.url), "utf8"));
export const RR = (k: string) => BigInt(rolesJson.registry[k]);
export const RS = (k: string) => BigInt(rolesJson.resolver[k]);

export const PROXY: Address = "0xD2BE04253E815972D6a1D995670eBAc7a6C8C786"; // nanitecom UserRegistry
export const ETH_REGISTRY: Address = "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4";
export const FACTORY: Address = "0xda70306c98e97ece36f997a21368e53298572991";
export const RESOLVER_IMPL: Address = "0x115eb53f0c60696633855f90b138178fb40b2b2c";
export const UR_V2: Address = "0x24e1d8e068620b647ca097f961a61055f4f42d72";
export const TEST_USER: Address = "0xfAD31e74F1Cb69046BBB2e4A15ce653beE6936C0";
export const AGENT0: Address = "0xC0575045B1acacC1349e3e5f8bE20FBA3a8E287b";
export const PARENT_EXPIRY = 1825432500n;
export const LABEL = "t04test";
export const NAME = "t04test.nanitecom.eth";
export const SALT = BigInt(keccak256(toBytes("nanite:t04test:agent0")));
export const PREDICTED_RESOLVER: Address = "0xd8Bab6066f02Edc516538d91c44Efae7e4145744";
export const DNS_NAME: Hex = toHex(packetToBytes(NAME));

export const abis = {
  registry: load("UserRegistryImpl.json"), ethRegistry: load("ETHRegistry.json"),
  resolver: load("PermissionedResolverImpl.json"), factory: load("VerifiableFactory.json"),
};

export const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
const wc = (account: any) => createWalletClient({ account, chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
export const operator = privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY as Hex);
export const agent = (i: number) => mnemonicToAccount(process.env.TEST_SEED_MNEMONIC as string, { addressIndex: i });
export const walletFor = wc;

export function errText(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    return rev ? `${rev.data?.errorName ?? rev.reason ?? "revert"}(${(rev.data?.args ?? []).map(String).join(", ")})` : e.shortMessage;
  }
  return String(e);
}

const DEP = new URL("../../config/sepolia-deployments.json", import.meta.url);
export function readDeployments(): Record<string, any> { return existsSync(DEP) ? JSON.parse(readFileSync(DEP, "utf8")) : { chainId: 11155111 }; }
export function record(key: string, value: unknown) {
  const d = readDeployments(); d[key] = value; writeFileSync(DEP, JSON.stringify(d, null, 2) + "\n");
}

// Simulate, then send, then wait. Throws (without sending) if the simulation fails.
export async function simSend(key: string, account: any, req: any, extra: Record<string, unknown> = {}) {
  let sim;
  try { sim = await client.simulateContract({ ...req, account }); }
  catch (e) { console.log(`${key}: SIMULATION FAILED, not sending: ${errText(e)}`); process.exit(1); }
  console.log(`${key}: simulation OK${sim.result !== undefined ? ` result=${String(sim.result)}` : ""}`);
  const hash = await walletFor(account).writeContract(sim.request as any);
  const rc = await client.waitForTransactionReceipt({ hash });
  console.log(`${key}: tx ${hash} block ${rc.blockNumber} status ${rc.status}`);
  record(key, { txHash: hash, blockNumber: Number(rc.blockNumber), status: rc.status, from: account.address, ...extra });
  if (rc.status !== "success") process.exit(1);
  return { hash, rc, result: sim.result };
}
