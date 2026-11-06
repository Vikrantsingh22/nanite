import { markNameClaimed, type Db } from "@nanite/db";
import { withOperatorLock } from "../operator-lock.js";
import type { ClaimEvent, ClaimStepId, UserNameChain } from "./types.js";

export type StepStatus = "pending" | "active" | "done" | "skipped";
export interface ClaimStep {
  id: ClaimStepId;
  label: string;
  status: StepStatus;
  txHash?: string;
}
export interface ClaimJob {
  userId: string;
  username: string;
  status: "queued" | "running" | "done" | "error";
  steps: ClaimStep[];
  error?: { code: string; message: string };
  startedAt: number;
}

const STEPS: Array<[ClaimStepId, string]> = [
  ["deploy-registry", "Deploy your name registry"],
  ["set-parent", "Link registry to nanitecom.eth"],
  ["register-username", "Register your username"],
];

/**
 * In-process ENS claim runner: one job at a time (single-flight, the operator wallet has one nonce),
 * one job per user. State lives in memory; the chain is the source of truth, so after a restart the
 * client simply POSTs the claim again and createUserName resumes (every step checks chain state first).
 */
export function createClaimRunner(db: Db, chain: UserNameChain, log: (line: string) => void) {
  const jobs = new Map<string, ClaimJob>();
  let tail: Promise<unknown> = Promise.resolve();

  async function run(job: ClaimJob, userWallet: string) {
    job.status = "running";
    const onEvent = (e: ClaimEvent) => {
      const step = job.steps.find((s) => s.id === e.step);
      if (!step) return;
      if (e.phase === "start") step.status = "active";
      else {
        step.status = "done";
        if (e.txHash) step.txHash = e.txHash;
      }
    };
    try {
      const { name } = await chain.createUserName({ username: job.username, userWallet }, onEvent);
      for (const s of job.steps) if (s.status === "pending" || s.status === "active") s.status = s.status === "active" ? "done" : "skipped";
      await markNameClaimed(db, job.userId, name);
      job.status = "done";
      log(JSON.stringify({ level: "info", event: "ens_claim_done", userId: job.userId }));
    } catch (e) {
      const step = job.steps.find((s) => s.status === "active");
      if (step) step.status = "pending";
      job.status = "error";
      // Chain error text can be long; keep a short, content-free message.
      job.error = { code: "chain_error", message: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
      log(JSON.stringify({ level: "error", event: "ens_claim_failed", userId: job.userId }));
    }
  }

  return {
    get(userId: string) {
      return jobs.get(userId);
    },
    /** Starts (or resumes) a claim. Returns the existing job if one is queued/running. */
    start(userId: string, username: string, userWallet: string): ClaimJob {
      const existing = jobs.get(userId);
      if (existing && (existing.status === "queued" || existing.status === "running")) return existing;
      const job: ClaimJob = {
        userId,
        username,
        status: "queued",
        steps: STEPS.map(([id, label]) => ({ id, label, status: "pending" as StepStatus })),
        startedAt: Date.now(),
      };
      jobs.set(userId, job);
      tail = tail.then(() => withOperatorLock(() => run(job, userWallet)));
      return job;
    },
    /** Test helper: resolves when everything queued so far has finished. */
    idle: () => tail.then(() => undefined),
  };
}
export type ClaimRunner = ReturnType<typeof createClaimRunner>;
