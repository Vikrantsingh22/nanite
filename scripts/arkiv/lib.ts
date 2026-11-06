// Shared helpers for the Arkiv spike (T0.3). Rabdi testnet, @arkiv-network/sdk 1.0.1.
// Never log keys or the mnemonic; addresses only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

export const CHAIN_ID = 7794095;
export const EXPLORER = "https://rabdi.explorer.arkiv.network";
export const ARKIV_ADDRESS = "0x4400000000000000000000000000000000000044" as const;
/** ARKIV_ACCESS_KEY is optional; empty = heavily rate-limited public RPC. */
export const accessKey = process.env.ARKIV_ACCESS_KEY ?? "";
export const chain = rabdi({ accessKey });
export const RPC_URL = chain.rpcUrls.default.http[0];

/** Index plan for ARKIV_TEST_MNEMONIC (m/44'/60'/0'/0/<index>). */
export const WALLET_ROLES = {
  0: "funder",
  1: "W1",
  2: "W2",
  3: "W3 operator",
  4: "W3 user",
  5: "W4",
  6: "W4 attacker",
} as const;

export function publicClient() {
  return createPublicClient({ chain, transport: http(undefined, { timeout: 15_000, retryCount: 1 }) });
}

export function account(index: number) {
  const m = process.env.ARKIV_TEST_MNEMONIC;
  if (!m) throw new Error("ARKIV_TEST_MNEMONIC missing in .env (run scripts/arkiv/wallets.ts)");
  return mnemonicToAccount(m, { addressIndex: index });
}

export function walletFor(index: number) {
  return createWalletClient({ chain, transport: http(), account: account(index) });
}
/** Alias: the wallet client factory for an arbitrary viem account. */
export const walletClientFor = (acc: ReturnType<typeof account>) =>
  createWalletClient({ chain, transport: http(), account: acc });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Public RPCs lag behind the writer: poll arkiv_getEntity until the entity is visible.
 * Returns the entity, or throws after timeoutMs (default 60s).
 */
export async function waitForQueryable(key: Hex, opts: { timeoutMs?: number; intervalMs?: number } = {}) {
  const { timeoutMs = 60_000, intervalMs = 2_000 } = opts;
  const pc = publicClient();
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      return await pc.getEntity(key);
    } catch (e) {
      lastErr = e; // NoEntityFoundError until indexed, or a rate-limit error
    }
    await sleep(intervalMs);
  }
  throw new Error(`entity ${key} not queryable after ${timeoutMs}ms: ${(lastErr as Error)?.message}`);
}

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (addr: string) => `${EXPLORER}/address/${addr}`;
export const entityUrl = (key: string) => `${EXPLORER}/entity/${key}`; // path unverified; check the explorer

const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/** Append a finding to docs/arkiv-spike/results/<worker>.json (a JSON array). */
export function recordFinding(worker: string, obj: Record<string, unknown>) {
  const file = resolve("docs/arkiv-spike/results", `${worker}.json`);
  mkdirSync(dirname(file), { recursive: true });
  const arr: unknown[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  arr.push({ at: new Date().toISOString(), ...obj });
  writeFileSync(file, JSON.stringify(arr, replacer, 2) + "\n");
}

export { appendFileSync };
