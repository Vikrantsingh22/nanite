import {
  createEnsService,
  createPublicEnsClient,
  createViemChainIO,
  loadEnsConfig,
  type CallSpec,
  type ChainIO,
  type NameReader,
  type RetentionPolicy,
  type SendPolicy,
} from "@nanite/ens";
import { getAddress } from "viem";

export type AgentStepId =
  | "deploy-resolver"
  | "register-agent"
  | "grant-keys"
  | "publish-signer"
  | "set-send-policy"
  | "set-retention"
  | "revoke-keys";

export interface AgentEvent {
  step: AgentStepId;
  phase: "start" | "done";
  txHash?: string;
}

/** Port to ENS for agent names (real: @nanite/ens on Sepolia; tests: a fake). */
export interface AgentChain {
  /** False without OPERATOR_PRIVATE_KEY: every write answers 503 operator_not_configured. */
  canWrite: boolean;
  createAgentName(
    a: { username: string; agentLabel: string; agentWallet: string; email: string; encryptionPublicKeyHex: string },
    onEvent: (e: AgentEvent) => void,
  ): Promise<{ name: string; resolver: string }>;
  readSendPolicy(ensName: string): Promise<SendPolicy>;
  setSendPolicy(
    a: { username: string; agentLabel: string; policy: string; allow?: string[]; limit?: number },
    onEvent: (e: AgentEvent) => void,
  ): Promise<void>;
  revokeAgent(
    a: { username: string; agentLabel: string; agentWallet: string },
    onEvent: (e: AgentEvent) => void,
  ): Promise<void>;
  /** Fresh read of the four retention records (defaults for missing/invalid values). */
  readRetentionPolicy(ensName: string): Promise<RetentionPolicy & { invalid: number }>;
  /** Operator `setText` of the retention records given (the agent wallet cannot write them). */
  setRetentionPolicy(
    a: { username: string; agentLabel: string; otpTtlMinutes?: number; mailTtlHours?: number; extend?: string; extendLimit?: number },
    onEvent: (e: AgentEvent) => void,
  ): Promise<void>;
  /** Operator `setText(nanite.signer, address)`; resumable (no tx when the record already matches). */
  publishSigner(a: { username: string; agentLabel: string; address: string }, onEvent: (e: AgentEvent) => void): Promise<void>;
  /** Fresh read of the `nanite.signer` text record (null when empty). */
  readSigner(ensName: string): Promise<string | null>;
}

const READ_ONLY_PLACEHOLDER_KEY = `0x${"11".repeat(32)}`;

const STEP_BY_FUNCTION: Record<string, AgentStepId> = {
  deployProxy: "deploy-resolver",
  register: "register-agent",
  grantSetterRoles: "grant-keys",
  setText: "set-send-policy",
  revokeRoles: "revoke-keys",
};

/** Real wiring on Sepolia. Without an operator key, reads still work and writes are disabled. */
export function createRealAgentChain(env: {
  operatorPrivateKey?: string | undefined;
  sepoliaRpcUrl?: string | undefined;
  apiPublicUrl?: string | undefined;
}): AgentChain {
  const config = loadEnsConfig({
    OPERATOR_PRIVATE_KEY: env.operatorPrivateKey ?? READ_ONLY_PLACEHOLDER_KEY,
    SEPOLIA_RPC_URL: env.sepoliaRpcUrl ?? "https://ethereum-sepolia-rpc.publicnode.com",
    ...(env.apiPublicUrl ? { API_PUBLIC_URL: env.apiPublicUrl } : {}),
  });
  const client = createPublicEnsClient(config);
  const opts = { universalResolverAddress: config.contracts.universalResolver } as const;
  const reader: NameReader = {
    getAddress: async (name) => {
      const a = await client.getEnsAddress({ name, ...opts });
      return a ? getAddress(a) : null;
    },
    getText: async (name, key) => (await client.getEnsText({ name, key, ...opts })) ?? null,
  };
  let emit: ((e: AgentEvent) => void) | undefined;
  /** Set while a job runs a step whose contract function is shared with another step (setText). */
  let forcedStep: AgentStepId | undefined;
  let service: ReturnType<typeof createEnsService> | undefined;
  const svc = () => {
    if (!service) {
      const base = createViemChainIO(config, client);
      const io: ChainIO = {
        ...base,
        send: async (call: CallSpec) => {
          const step = forcedStep ?? STEP_BY_FUNCTION[call.functionName];
          if (step) emit?.({ step, phase: "start" });
          const tx = await base.send(call);
          if (step) emit?.({ step, phase: "done", txHash: tx.hash });
          return tx;
        },
      };
      service = createEnsService({ config, io, reader });
    }
    return service;
  };
  const canWrite = !!env.operatorPrivateKey;
  // Jobs are serialised by the process-wide operator lock, so one `emit` slot at a time is safe.
  const withEmit = async <T>(onEvent: (e: AgentEvent) => void, fn: () => Promise<T>): Promise<T> => {
    if (!canWrite) throw new Error("operator not configured");
    emit = onEvent;
    try {
      return await fn();
    } finally {
      emit = undefined;
    }
  };

  return {
    canWrite,
    readSendPolicy: (name) => svc().readSendPolicy(name),
    createAgentName: (a, onEvent) =>
      withEmit(onEvent, async () => {
        const r = await svc().createAgentName({
          username: a.username,
          agentLabel: a.agentLabel,
          agentWallet: getAddress(a.agentWallet),
          email: a.email,
          encryptionPublicKeyHex: a.encryptionPublicKeyHex,
          sendPolicy: "reply-only",
        });
        return { name: r.name, resolver: r.resolver.toLowerCase() };
      }),
    setSendPolicy: (a, onEvent) =>
      withEmit(onEvent, async () => {
        await svc().setSendPolicy(a);
      }),
    readRetentionPolicy: (name) => svc().readRetentionPolicy(name),
    setRetentionPolicy: (a, onEvent) =>
      withEmit(onEvent, async () => {
        forcedStep = "set-retention";
        try {
          await svc().setRetentionPolicy(a);
        } finally {
          forcedStep = undefined;
        }
      }),
    revokeAgent: (a, onEvent) =>
      withEmit(onEvent, async () => {
        await svc().revokeAgent({ username: a.username, agentLabel: a.agentLabel, agentWallet: getAddress(a.agentWallet) });
      }),
    publishSigner: (a, onEvent) =>
      withEmit(onEvent, async () => {
        forcedStep = "publish-signer";
        try {
          await svc().publishSigner(a);
        } finally {
          forcedStep = undefined;
        }
      }),
    readSigner: (name) => svc().readSigner(name),
  };
}
