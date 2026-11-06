import type { Db } from "@nanite/db";

export type ChainNameStatus = "available" | "reserved" | "registered";

export type ClaimStepId = "deploy-registry" | "set-parent" | "register-username";

export interface ClaimEvent {
  step: ClaimStepId;
  phase: "start" | "done";
  txHash?: string;
}

/** Port to ENS (real: @nanite/ens on Sepolia; tests: a fake). */
export interface UserNameChain {
  /** False when OPERATOR_PRIVATE_KEY is missing: claiming answers 503 operator_not_configured. */
  canClaim: boolean;
  lookup(username: string): Promise<{ status: ChainNameStatus; owner?: string }>;
  createUserName(
    args: { username: string; userWallet: string },
    onEvent: (e: ClaimEvent) => void,
  ): Promise<{ name: string }>;
}

export interface AuthDeps {
  db: Db;
  /** Chain ids accepted in SIWE messages. */
  chainIds: number[];
  /** Set the Secure cookie attribute (production). */
  secureCookie: boolean;
  sessionTtlSeconds?: number;
  chain?: UserNameChain;
}

export const SESSION_COOKIE = "nanite_session";
