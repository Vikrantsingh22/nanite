import type { Db } from "@nanite/db";
import { setAgentResolver } from "./queries.js";
import { withOperatorLock } from "../operator-lock.js";
import type { AgentChain, AgentEvent, AgentStepId } from "./chain.js";

export type StepStatus = "pending" | "active" | "done" | "skipped";
export type AgentJobKind = "create" | "policy" | "retention" | "revoke" | "signer";

export interface AgentStep {
  id: AgentStepId;
  label: string;
  status: StepStatus;
  txHash?: string;
}
export interface AgentJob {
  agentId: string;
  kind: AgentJobKind;
  status: "queued" | "running" | "done" | "error";
  steps: AgentStep[];
  error?: { code: string; message: string };
}

const STEPS: Record<AgentJobKind, Array<[AgentStepId, string]>> = {
  create: [
    ["deploy-resolver", "Deploy the agent's resolver"],
    ["register-agent", "Register the agent name"],
    ["grant-keys", "Grant the agent its one writable record"],
  ],
  policy: [["set-send-policy", "Write the send policy to ENS"]],
  retention: [["set-retention", "Write the retention settings to ENS"]],
  revoke: [["revoke-keys", "Remove the agent's write access"]],
  signer: [["publish-signer", "Publish the mail-signing key"]],
};
const PUBLISH_SIGNER: [AgentStepId, string] = STEPS.signer[0]!;

export interface CreateArgs {
  username: string;
  agentLabel: string;
  agentWallet: string;
  email: string;
  encryptionPublicKeyHex: string;
  /** Address of the agent's mail-signing key (custody = nanite). Absent: no publish-signer step. */
  signerAddress?: string | undefined;
}
export interface SignerArgs {
  username: string;
  agentLabel: string;
  /** The new signer address to publish. */
  address: string;
  /** Runs only after the record is on chain: stores the new sealed key, so sending switches keys atomically with ENS. */
  commit: () => Promise<void>;
}
export interface PolicyArgs {
  username: string;
  agentLabel: string;
  policy: string;
  allow?: string[] | undefined;
  limit?: number | undefined;
}
export interface RetentionArgs {
  username: string;
  agentLabel: string;
  otpTtlMinutes?: number | undefined;
  mailTtlHours?: number | undefined;
  extend?: string | undefined;
  extendLimit?: number | undefined;
}
export interface RevokeArgs {
  username: string;
  agentLabel: string;
  agentWallet: string;
}

/**
 * In-process runner for operator-signed agent work: one job at a time process-wide (operator nonce),
 * latest job per agent kept in memory. The chain is the source of truth, and every ENS step is
 * idempotent, so after a restart the client simply retries.
 */
export function createAgentJobRunner(db: Db, chain: AgentChain, log: (line: string) => void) {
  const jobs = new Map<string, AgentJob>();

  function enqueue(
    agentId: string,
    kind: AgentJobKind,
    work: (onEvent: (e: AgentEvent) => void, job: AgentJob) => Promise<void>,
    steps: Array<[AgentStepId, string]> = STEPS[kind],
  ) {
    const job: AgentJob = {
      agentId,
      kind,
      status: "queued",
      steps: steps.map(([id, label]) => ({ id, label, status: "pending" as StepStatus })),
    };
    jobs.set(agentId, job);
    const onEvent = (e: AgentEvent) => {
      const step = job.steps.find((s) => s.id === e.step);
      if (!step) return;
      if (e.phase === "start") step.status = "active";
      else {
        step.status = "done";
        if (e.txHash) step.txHash = e.txHash;
      }
    };
    void withOperatorLock(async () => {
      job.status = "running";
      try {
        await work(onEvent, job);
        for (const s of job.steps) if (s.status !== "done") s.status = s.status === "active" ? "done" : "skipped";
        job.status = "done";
        log(JSON.stringify({ level: "info", event: `agent_${kind}_done`, agentId }));
      } catch (e) {
        const step = job.steps.find((s) => s.status === "active");
        if (step) step.status = "pending";
        job.status = "error";
        job.error = { code: "chain_error", message: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
        log(JSON.stringify({ level: "error", event: `agent_${kind}_failed`, agentId }));
      }
    });
    return job;
  }

  const busy = (agentId: string) => {
    const j = jobs.get(agentId);
    return !!j && (j.status === "queued" || j.status === "running");
  };

  return {
    get: (agentId: string) => jobs.get(agentId),
    busy,
    startCreate(agentId: string, a: CreateArgs) {
      const { signerAddress, ...nameArgs } = a;
      return enqueue(
        agentId,
        "create",
        async (onEvent) => {
          const r = await chain.createAgentName(nameArgs, onEvent);
          await setAgentResolver(db, agentId, r.resolver);
          if (signerAddress) {
            await chain.publishSigner({ username: a.username, agentLabel: a.agentLabel, address: signerAddress }, onEvent);
          }
        },
        signerAddress ? [...STEPS.create, PUBLISH_SIGNER] : STEPS.create,
      );
    },
    /** Create or rotate the mail-signing key: publish the address to ENS, then switch the stored key. */
    startSigner(agentId: string, a: SignerArgs) {
      return enqueue(agentId, "signer", async (onEvent) => {
        await chain.publishSigner({ username: a.username, agentLabel: a.agentLabel, address: a.address }, onEvent);
        await a.commit();
      });
    },
    startPolicy(agentId: string, a: PolicyArgs) {
      return enqueue(agentId, "policy", async (onEvent) => {
        await chain.setSendPolicy(a, onEvent);
      });
    },
    startRetention(agentId: string, a: RetentionArgs) {
      return enqueue(agentId, "retention", async (onEvent) => {
        await chain.setRetentionPolicy(
          {
            username: a.username,
            agentLabel: a.agentLabel,
            ...(a.otpTtlMinutes !== undefined ? { otpTtlMinutes: a.otpTtlMinutes } : {}),
            ...(a.mailTtlHours !== undefined ? { mailTtlHours: a.mailTtlHours } : {}),
            ...(a.extend !== undefined ? { extend: a.extend } : {}),
            ...(a.extendLimit !== undefined ? { extendLimit: a.extendLimit } : {}),
          },
          onEvent,
        );
      });
    },
    startRevoke(agentId: string, a: RevokeArgs) {
      return enqueue(agentId, "revoke", async (onEvent) => {
        await chain.revokeAgent(a, onEvent);
      });
    },
    /** Test helper: resolves when everything queued so far has finished. */
    idle: () => withOperatorLock(async () => undefined),
  };
}
export type AgentJobRunner = ReturnType<typeof createAgentJobRunner>;
