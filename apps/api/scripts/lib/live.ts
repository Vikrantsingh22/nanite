/*
 * Shared helpers for the live scripts (live-e2e.ts, seed-demo.ts). They drive the REAL HTTP API as the test
 * user wallet and run the same @nanite/crypto code the browser runs.
 *
 * Output rules: only step results, tx hashes, entity keys, addresses and booleans are ever printed. Keys,
 * tokens, signatures, cookies, seeds, the recovery code and email content are never printed or written.
 */
import {
  KEY_DERIVATION_MESSAGE,
  decryptEmail,
  deriveAgentWallet,
  prepareKeys,
  probeDeterministicSignature,
  ready,
  unlockWithBundle,
  type DecryptedEmail,
  type KeyBundle,
  type UnlockedKeys,
} from "@nanite/crypto";
import { createEnsServiceFromConfig, loadEnsConfig, type EnsService } from "@nanite/ens";
import { createPublicClient, formatEther, http, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createSiweMessage } from "viem/siwe";

export const RABDI_RPC = "https://rpc.rabdi.db-chain.testnet.arkiv.network";
export const ARKIV_EXPLORER = "https://rabdi.explorer.arkiv.network";
export const SEPOLIA_ETHERSCAN_TX = "https://sepolia.etherscan.io/tx/";
export const MIN_OPERATOR_ETH = 0.05;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LiveEnv {
  apiUrl: string;
  webOrigin: string;
  sepoliaRpc: string;
  arkivRpc: string;
  userKey: Hex;
  /** ENS operator key: only used to derive its address and read its balance. */
  ensOperatorKey: Hex | undefined;
  /** Arkiv operator key: only used to derive its address ($creator pin). */
  arkivOperatorKey: Hex | undefined;
  webhookSecret: string | undefined;
}

export function loadLiveEnv(env: Record<string, string | undefined> = process.env): LiveEnv {
  const need = (name: string) => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is missing in .env`);
    return v;
  };
  const hex = (name: string, v: string | undefined) => {
    if (v && !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} is malformed`);
    return v as Hex | undefined;
  };
  return {
    apiUrl: (env.API_URL?.trim() || "http://api:4000").replace(/\/+$/, ""),
    webOrigin: new URL(env.WEB_ORIGIN?.trim() || "http://localhost:3000").origin,
    sepoliaRpc: need("SEPOLIA_RPC_URL"),
    arkivRpc: env.ARKIV_RPC_URL?.trim() || RABDI_RPC,
    userKey: hex("TEST_USER_PRIVATE_KEY", need("TEST_USER_PRIVATE_KEY"))!,
    ensOperatorKey: hex("OPERATOR_PRIVATE_KEY", env.OPERATOR_PRIVATE_KEY?.trim()),
    arkivOperatorKey: hex("ARKIV_OPERATOR_PRIVATE_KEY", env.ARKIV_OPERATOR_PRIVATE_KEY?.trim()),
    webhookSecret: env.RESEND_WEBHOOK_SECRET?.trim() || undefined,
  };
}

// ---------------------------------------------------------------- HTTP client with a cookie jar

export interface ApiResult<T = any> {
  status: number;
  json: T;
}

export class ApiClient {
  private cookies = new Map<string, string>();
  constructor(
    readonly baseUrl: string,
    readonly origin: string,
  ) {}

  async request<T = any>(method: string, path: string, o: { body?: unknown; token?: string; session?: boolean } = {}): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { origin: this.origin };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.session !== false && !o.token && this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair!.indexOf("=");
      if (i > 0) this.cookies.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { _nonJson: true };
    }
    return { status: res.status, json };
  }
  get = <T = any>(path: string, o?: { token?: string; session?: boolean }) => this.request<T>("GET", path, o);
  post = <T = any>(path: string, body?: unknown, o?: { token?: string; session?: boolean }) =>
    this.request<T>("POST", path, { ...o, ...(body !== undefined ? { body } : {}) });
  put = <T = any>(path: string, body?: unknown, o?: { token?: string }) => this.request<T>("PUT", path, { ...o, ...(body !== undefined ? { body } : {}) });
}

export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined | null | false>,
  o: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const end = Date.now() + o.timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      if ((e as { fatal?: boolean } | null)?.fatal) throw e;
      last = e;
    }
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}${last instanceof Error ? ` (last error: ${last.message.slice(0, 120)})` : ""}`);
    await sleep(o.intervalMs ?? 2000);
  }
}

// ---------------------------------------------------------------- steps (same calls the web makes)

export type Say = (line: string) => void;

/** a. SIWE sign-in exactly as apps/web/src/lib/session-context.tsx builds it. */
export async function siweLogin(api: ApiClient, account: PrivateKeyAccount, webOrigin: string) {
  const { status, json } = await api.get<{ nonce: string }>("/auth/nonce", { session: false });
  if (status !== 200 || !json?.nonce) throw new Error(`/auth/nonce answered ${status}`);
  const message = createSiweMessage({
    address: account.address,
    chainId: 11155111,
    domain: new URL(webOrigin).host,
    nonce: json.nonce,
    uri: webOrigin,
    version: "1",
    statement: "Sign in to Nanite. This does not unlock your mailbox and costs no gas.",
  });
  const signature = await account.signMessage({ message });
  const v = await api.post("/auth/verify", { message, signature }, { session: false });
  if (v.status !== 200) throw new Error(`/auth/verify answered ${v.status} ${v.json?.reason ?? v.json?.error ?? ""}`);
  return v.json as { wallet: string; username: string | null; ensName: string | null; onboardingState: string; hasKeys: boolean };
}

/** b. Create the keys as the browser does, or unlock the stored bundle with the wallet signature (resume). */
export async function ensureKeys(api: ApiClient, account: PrivateKeyAccount, me: { hasKeys: boolean }): Promise<{ keys: UnlockedKeys; created: boolean }> {
  await ready();
  const sign = (message: string) => account.signMessage({ message });
  if (!me.hasKeys) {
    const probe = await probeDeterministicSignature(sign);
    if (!probe.deterministic) throw new Error("wallet signatures are not deterministic");
    const prepared = await prepareKeys({ kind: "signature", signature: probe.signature });
    const r = await api.post("/onboarding/keys", prepared.bundle);
    if (r.status !== 201) throw new Error(`/onboarding/keys answered ${r.status} ${r.json?.error ?? ""}`);
    return { keys: prepared.unlocked, created: true };
  }
  const stored = await api.get<KeyBundle & { keyVersion?: number }>("/onboarding/keys");
  if (stored.status !== 200) throw new Error(`GET /onboarding/keys answered ${stored.status}`);
  try {
    const keys = await unlockWithBundle(stored.json, { kind: "signature", signature: await sign(KEY_DERIVATION_MESSAGE) });
    return { keys, created: false };
  } catch {
    throw new Error("could not unlock the stored keys with this wallet (placeholder dev-seed keys? use a fresh database)");
  }
}

export interface Step {
  id: string;
  label: string;
  status: string;
  txHash?: string;
}

/** c. Claim the username (real Sepolia txs), poll to done, then complete onboarding. */
export async function ensureUsername(api: ApiClient, username: string, say: Say): Promise<{ ensName: string; txs: Step[] }> {
  let st = await api.get("/onboarding/status");
  if (st.status !== 200) throw new Error(`/onboarding/status answered ${st.status}`);
  if (st.json.onboardingState !== "name_claimed" && st.json.onboardingState !== "done") {
    if (!st.json.canClaim) throw new Error("API cannot claim usernames (operator_not_configured)");
    const avail = await api.get(`/onboarding/username/${username}/available`);
    if (avail.status !== 200 || !avail.json.available) throw new Error(`username ${username} not available (${avail.json?.reason ?? avail.status})`);
    const r = await api.post("/onboarding/username", { username });
    if (r.status !== 202) throw new Error(`/onboarding/username answered ${r.status} ${r.json?.error ?? ""}`);
    say(`  claim started for ${username}`);
    st = await waitFor(
      "username claim",
      async () => {
        const s = await api.get("/onboarding/status");
        if (s.json?.claim?.status === "error") throw Object.assign(new Error(`claim failed: ${s.json.claim.error?.message ?? ""}`), { fatal: true });
        return s.json?.onboardingState === "name_claimed" || s.json?.onboardingState === "done" || s.json?.claim?.status === "done" ? s : null;
      },
      { timeoutMs: 8 * 60_000, intervalMs: 3000 },
    );
  }
  const done = await api.post("/onboarding/complete");
  if (done.status !== 200) throw new Error(`/onboarding/complete answered ${done.status}`);
  const final = await api.get("/onboarding/status");
  return { ensName: final.json.ensName as string, txs: (final.json.claim?.steps ?? []) as Step[] };
}

export interface AgentInfo {
  id: string;
  name: string;
  ensName: string;
  email: string;
  walletAddress: string;
  index: number;
  /** Fresh agent token (shown once on create; rotated on resume). */
  token: string;
  created: boolean;
  txs: Step[];
}

/** d. Add an agent: wallet derived from the seed in memory, only the address is posted. Resumes by name. */
export async function ensureAgent(
  api: ApiClient,
  keys: UnlockedKeys,
  name: string,
  say: Say,
  opts: { rotateToken?: boolean } = {},
): Promise<AgentInfo> {
  const list = await api.get("/agents");
  if (list.status !== 200) throw new Error(`/agents answered ${list.status}`);
  const existing = (list.json.agents as any[]).find((a) => a.name === name && a.status !== "revoked");
  let agent = existing;
  let token: string | undefined;
  let txs: Step[] = [];
  let created = false;
  if (!agent) {
    const index = (list.json.agents as any[]).length;
    let useIndex = index;
    for (let attempt = 0; attempt < 2; attempt++) {
      const wallet = await deriveAgentWallet(keys.seed, useIndex);
      const r = await api.post("/agents", { name, index: useIndex, walletAddress: wallet.address });
      if (r.status === 409 && r.json?.error === "index_mismatch" && typeof r.json.expected === "number") {
        useIndex = r.json.expected;
        continue;
      }
      if (r.status !== 202) throw new Error(`POST /agents answered ${r.status} ${r.json?.error ?? ""}`);
      agent = r.json.agent;
      token = r.json.token;
      created = true;
      break;
    }
    if (!agent) throw new Error("could not create the agent");
    say(`  agent ${agent.ensName} creating (index ${agent.index})`);
  }
  // Poll /agents/:id/status until active (retry once if the job failed).
  let retried = false;
  const status = await waitFor(
    "agent active",
    async () => {
      const s = await api.get(`/agents/${agent.id}/status`);
      if (s.status !== 200) throw new Error(`status ${s.status}`);
      if (s.json.agentStatus === "active") return s.json;
      if (s.json.agentStatus === "failed" || s.json.status === "error") {
        if (!retried) {
          retried = true;
          say(`  agent job reported ${s.json.error?.code ?? "failure"}, retrying once`);
          await api.post(`/agents/${agent.id}/retry`);
          return null;
        }
        throw Object.assign(new Error(`agent job failed: ${s.json.error?.message ?? ""}`), { fatal: true });
      }
      return null;
    },
    { timeoutMs: 10 * 60_000, intervalMs: 3000 },
  );
  txs = (status.steps ?? []) as Step[];
  if (!token && opts.rotateToken !== false) {
    const r = await api.post(`/agents/${agent.id}/token`);
    if (r.status !== 201) throw new Error(`token rotate answered ${r.status}`);
    token = r.json.token;
  }
  return { id: agent.id, name, ensName: agent.ensName, email: agent.email, walletAddress: agent.walletAddress, index: agent.index, token: token ?? "", created, txs };
}

// ---------------------------------------------------------------- reads

export interface MailEntity {
  key: string;
  type: "otp" | "conversation" | "sent";
  receivedAt: number;
  keyIds: string[];
  owner: string;
  creator: string;
  ciphertext: string;
  wrappedKeys: string;
  nonce: string;
  expiresAtBlock: string;
}

const unb64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

export async function listInbox(api: ApiClient, agentId: string, type?: string): Promise<MailEntity[]> {
  const r = await api.get(`/mail/${agentId}/inbox?limit=50${type ? `&type=${type}` : ""}`);
  if (r.status !== 200) throw new Error(`/mail inbox answered ${r.status} ${r.json?.error ?? ""}`);
  return r.json.items as MailEntity[];
}

/** Client-side decryption with the user's own key, exactly like apps/web/src/components/inbox/mail.ts. */
export async function decryptMail(e: MailEntity, keys: UnlockedKeys): Promise<DecryptedEmail | null> {
  if (!e.keyIds.includes(keys.keyId)) return null;
  try {
    return await decryptEmail(
      { ciphertext: unb64(e.ciphertext), wrappedKeys: unb64(e.wrappedKeys), nonce: unb64(e.nonce) },
      { keyId: keys.keyId, publicKey: keys.publicKey, privateKey: keys.privateKey },
    );
  } catch {
    return null;
  }
}

/** Decrypt every entity of a list; returns [entity, plaintext|null] pairs. */
export async function decryptAll(items: MailEntity[], keys: UnlockedKeys) {
  const out: Array<{ entity: MailEntity; mail: DecryptedEmail | null }> = [];
  for (const entity of items) out.push({ entity, mail: await decryptMail(entity, keys) });
  return out;
}

// ---------------------------------------------------------------- chain reads

export interface RawArkivResult {
  /** The raw JSON-RPC response text (never printed; used for substring checks only). */
  raw: string;
  entities: Array<{ key: string; owner: string; creator: string; expiresAtBlock: number }>;
  atBlock: number;
}

const hexToNum = (v: unknown) => (typeof v === "string" && v.startsWith("0x") ? Number(BigInt(v)) : Number(v ?? 0));

/** Raw `arkiv_query` for one entity key, pinned to the creator, selecting EVERYTHING the node stores. */
export async function rawQueryByKey(rpc: string, key: string, creator: string): Promise<RawArkivResult> {
  const query = `arkiv.schema = str('nanite.email.v1') AND $key = key(${key}) AND $creator = addr(${creator})`;
  return rawQuery(rpc, query);
}

export async function rawQuery(rpc: string, query: string): Promise<RawArkivResult> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "arkiv_query",
    params: [
      query,
      {
        select: {
          key: true,
          owner: true,
          creator: true,
          expiresAt: true,
          createdAt: true,
          attributes: {
            agentId: true, ownerId: true, type: true, receivedAt: true, threadId: true, senderHash: true,
            keyIds: true, ciphertext: true, wrappedKeys: true, nonce: true,
          },
        },
        limit: "0x14",
      },
    ],
  };
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const raw = await res.text();
  const j = JSON.parse(raw) as { error?: { message?: string }; result?: { data?: any[]; blockNumber?: string } };
  if (j.error) throw new Error(`arkiv_query error: ${String(j.error.message).slice(0, 400)}`);
  const data = j.result?.data ?? [];
  return {
    raw,
    atBlock: hexToNum(j.result?.blockNumber),
    entities: data.map((d) => ({ key: d.key, owner: String(d.owner).toLowerCase(), creator: String(d.creator).toLowerCase(), expiresAtBlock: hexToNum(d.expiresAt) })),
  };
}

export async function arkivBlockNumber(rpc: string): Promise<number> {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
  return hexToNum(((await res.json()) as { result?: string }).result);
}

export function sepoliaClient(rpc: string) {
  return createPublicClient({ chain: sepolia, transport: http(rpc) });
}

export async function operatorBalanceEth(env: LiveEnv): Promise<{ address: Address; eth: number } | null> {
  if (!env.ensOperatorKey) return null;
  const address = privateKeyToAccount(env.ensOperatorKey).address;
  const wei = await sepoliaClient(env.sepoliaRpc).getBalance({ address });
  return { address, eth: Number(formatEther(wei)) };
}

/** Read-only ENS service (the key is a dummy: nothing here ever signs). */
export function readOnlyEns(sepoliaRpc: string): EnsService {
  return createEnsServiceFromConfig(loadEnsConfig({ OPERATOR_PRIVATE_KEY: `0x${"11".repeat(32)}`, SEPOLIA_RPC_URL: sepoliaRpc }));
}

export function userAccount(env: LiveEnv): PrivateKeyAccount {
  return privateKeyToAccount(env.userKey);
}

export const txLink = (h: string) => `${SEPOLIA_ETHERSCAN_TX}${h}`;
export const entityLink = (k: string) => `${ARKIV_EXPLORER}/entity/${k}`;
