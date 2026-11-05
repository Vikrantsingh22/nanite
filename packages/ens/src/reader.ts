import { getAddress } from "viem";
import { createPublicEnsClient } from "./chain.js";
import { loadEnsConfig } from "./config.js";
import type { NameReader } from "./service.js";

export const DEFAULT_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

/**
 * Read-only ENS reader on Sepolia through UniversalResolverV2 (fresh reads, no cache). It needs no key: the
 * placeholder below only satisfies the shared config loader and is never used to sign anything.
 * This is the `ensClient` for `verifyNaniteSignature`.
 */
export function createSepoliaNameReader(rpcUrl: string = DEFAULT_SEPOLIA_RPC): NameReader {
  const config = loadEnsConfig({ OPERATOR_PRIVATE_KEY: `0x${"11".repeat(32)}`, SEPOLIA_RPC_URL: rpcUrl });
  const client = createPublicEnsClient(config);
  const opts = { universalResolverAddress: config.contracts.universalResolver } as const;
  return {
    getAddress: async (name) => {
      const a = await client.getEnsAddress({ name, ...opts });
      return a ? getAddress(a) : null;
    },
    getText: async (name, key) => (await client.getEnsText({ name, key, ...opts })) ?? null,
  };
}
