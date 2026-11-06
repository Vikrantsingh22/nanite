import {
  abis,
  createEnsService,
  createPublicEnsClient,
  createViemChainIO,
  labelhash,
  loadEnsConfig,
  STATUS,
  type CallSpec,
  type ChainIO,
  type RegistryState,
} from "@nanite/ens";
import { getAddress } from "viem";
import type { ClaimEvent, ClaimStepId, UserNameChain } from "./types.js";

const STEP_BY_FUNCTION: Record<string, ClaimStepId> = {
  deployProxy: "deploy-registry",
  setParent: "set-parent",
  register: "register-username",
};

/** Read-only config trick: addresses are public; this key is never used to sign (canClaim is false). */
const READ_ONLY_PLACEHOLDER_KEY = `0x${"11".repeat(32)}`;

/** Real ENS wiring on Sepolia. Without an operator key, lookups still work and claiming is disabled. */
export function createRealUserNameChain(env: {
  operatorPrivateKey?: string | undefined;
  sepoliaRpcUrl?: string | undefined;
  apiPublicUrl?: string | undefined;
}): UserNameChain {
  const rpc = env.sepoliaRpcUrl ?? "https://ethereum-sepolia-rpc.publicnode.com";
  const config = loadEnsConfig({
    OPERATOR_PRIVATE_KEY: env.operatorPrivateKey ?? READ_ONLY_PLACEHOLDER_KEY,
    SEPOLIA_RPC_URL: rpc,
    ...(env.apiPublicUrl ? { API_PUBLIC_URL: env.apiPublicUrl } : {}),
  });
  const client = createPublicEnsClient(config);
  const canClaim = !!env.operatorPrivateKey;
  let io: ChainIO | undefined;
  let emit: ((e: ClaimEvent) => void) | undefined;

  const service = () => {
    if (!io) {
      const base = createViemChainIO(config, client);
      io = {
        ...base,
        send: async (call: CallSpec) => {
          const step = STEP_BY_FUNCTION[call.functionName];
          if (step) emit?.({ step, phase: "start" });
          const tx = await base.send(call);
          if (step) emit?.({ step, phase: "done", txHash: tx.hash });
          return tx;
        },
      };
    }
    return createEnsService({ config, io, reader: { getAddress: async () => null, getText: async () => null } });
  };

  return {
    canClaim,
    async lookup(username) {
      const s = (await client.readContract({
        address: config.contracts.parentRegistry,
        abi: abis.userRegistry,
        functionName: "getState",
        args: [labelhash(username)],
      })) as RegistryState;
      if (s.status === STATUS.AVAILABLE) return { status: "available" };
      if (s.status === STATUS.REGISTERED) return { status: "registered", owner: getAddress(s.latestOwner).toLowerCase() };
      return { status: "reserved" };
    },
    async createUserName({ username, userWallet }, onEvent) {
      if (!canClaim) throw new Error("operator not configured");
      // createViemChainIO serialises sends per process; the runner also serialises whole jobs.
      emit = onEvent;
      try {
        const r = await service().createUserName({ username, userWallet: getAddress(userWallet) });
        return { name: r.name };
      } finally {
        emit = undefined;
      }
    },
  };
}
