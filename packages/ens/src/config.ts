import { getAddress, type Address, type Hex } from "viem";
import sepolia from "../../../config/sepolia.json" with { type: "json" };

export interface EnsConfig {
  chainId: number;
  rpcUrl: string;
  /** Operator wallet key (server-side only). Never the owner wallet. */
  operatorPrivateKey: Hex;
  /** Parent name registered in the ETHRegistry, e.g. "nanitecom". */
  parentLabel: string;
  contracts: {
    ethRegistry: Address;
    factory: Address;
    userRegistryImpl: Address;
    resolverImpl: Address;
    universalResolver: Address;
    /** The nanitecom.eth UserRegistry proxy (children are registered here). */
    parentRegistry: Address;
  };
  /** Placeholder agent-endpoint[mcp] base URL (API_PUBLIC_URL). */
  apiPublicUrl: string;
}

export const PARENT_REGISTRY_PROXY: Address = "0xD2BE04253E815972D6a1D995670eBAc7a6C8C786";

export function loadEnsConfig(env: Record<string, string | undefined> = process.env): EnsConfig {
  const key = env.OPERATOR_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("OPERATOR_PRIVATE_KEY missing or malformed");
  const rpcUrl = env.SEPOLIA_RPC_URL;
  if (!rpcUrl) throw new Error("SEPOLIA_RPC_URL missing");
  const c = sepolia.contracts;
  return {
    chainId: sepolia.chainId,
    rpcUrl,
    operatorPrivateKey: key as Hex,
    parentLabel: "nanitecom",
    contracts: {
      ethRegistry: getAddress(c.ETHRegistry),
      factory: getAddress(c.VerifiableFactory),
      userRegistryImpl: getAddress(c.UserRegistryImpl),
      resolverImpl: getAddress(c.PermissionedResolverImpl),
      universalResolver: getAddress(c.UniversalResolverV2),
      parentRegistry: getAddress(env.NANITE_PARENT_REGISTRY ?? PARENT_REGISTRY_PROXY),
    },
    apiPublicUrl: (env.API_PUBLIC_URL ?? "http://localhost:4000").replace(/\/+$/, ""),
  };
}
