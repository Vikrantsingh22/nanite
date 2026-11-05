// Thin I/O layer over viem so the service logic can be unit-tested with a fake chain.
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { EnsConfig } from "./config.js";

export interface CallSpec {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

export interface SentTx {
  hash: Hex;
  gasUsed: bigint;
  /** Simulation result (e.g. register() returns the tokenId). */
  result: unknown;
}

export interface ChainIO {
  /** Operator address (the deployer used for VerifiableFactory salts). */
  operator: Address;
  /** Latest block timestamp, seconds. */
  now(): Promise<bigint>;
  hasCode(address: Address): Promise<boolean>;
  /** Poll until code is visible (the public RPC can serve stale reads right after a receipt). */
  waitForCode(address: Address): Promise<void>;
  read(call: CallSpec): Promise<unknown>;
  /** Simulate (throws, sending nothing, if it would revert), then send and wait for the receipt. */
  send(call: CallSpec): Promise<SentTx>;
}

export function errText(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    return rev
      ? `${rev.data?.errorName ?? rev.reason ?? "revert"}(${(rev.data?.args ?? []).map(String).join(", ")})`
      : e.shortMessage;
  }
  return String(e);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createPublicEnsClient(config: Pick<EnsConfig, "rpcUrl">): PublicClient {
  // cacheTime 0: reads (send policy, resolution) must always be fresh.
  return createPublicClient({ chain: sepolia, transport: http(config.rpcUrl), cacheTime: 0 }) as PublicClient;
}

export function createViemChainIO(config: EnsConfig, publicClient?: PublicClient): ChainIO {
  const account = privateKeyToAccount(config.operatorPrivateKey);
  const client = publicClient ?? createPublicEnsClient(config);
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(config.rpcUrl) });
  // Single-flight: nonce-ordered sends from one operator account.
  let queue: Promise<unknown> = Promise.resolve();

  const sendNow = async (call: CallSpec): Promise<SentTx> => {
    let sim: Awaited<ReturnType<PublicClient["simulateContract"]>> | undefined;
    let lastErr: unknown;
    // A simulation right after a previous receipt can hit a stale node; retry a few times before giving up.
    for (let i = 0; i < 4 && !sim; i++) {
      try {
        sim = await client.simulateContract({ ...call, account } as never);
      } catch (e) {
        lastErr = e;
        await sleep(2500);
      }
    }
    if (!sim) throw new Error(`${call.functionName}: simulation failed, nothing sent: ${errText(lastErr)}`);
    const hash = await wallet.writeContract(sim.request as never);
    const rc = await client.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${call.functionName}: tx ${hash} reverted`);
    return { hash, gasUsed: rc.gasUsed, result: sim.result };
  };

  const hasCode = async (address: Address) => {
    const c = await client.getCode({ address });
    return !!c && c !== "0x";
  };

  return {
    operator: account.address,
    now: async () => (await client.getBlock()).timestamp,
    hasCode,
    waitForCode: async (address) => {
      for (let i = 0; i < 20; i++) {
        if (await hasCode(address)) return;
        await sleep(1500);
      }
      throw new Error(`no code at ${address} after waiting`);
    },
    read: (call) => client.readContract(call as never),
    send: (call) => {
      const run = queue.then(() => sendNow(call));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
