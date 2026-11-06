import {
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  toBytes,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { packetToBytes } from "viem/ens";
import { abis } from "./abis.js";
import { createPublicEnsClient, createViemChainIO, type CallSpec, type ChainIO } from "./chain.js";
import type { EnsConfig } from "./config.js";
import {
  parseRetention,
  parseSendPolicy,
  RETENTION_KEYS,
  SEND_KEYS,
  validateRetentionInput,
  validateSendPolicyInput,
  type RetentionPolicy,
  type SendPolicy,
} from "./policy.js";
import {
  AGENT_NAME_ROLES,
  AGENT_SETTER_KEYS,
  ALL_ROLES,
  REGISTRY_ROLE,
  RESOLVER_GRANTS,
  RESOLVER_ROLE,
  USER_NAME_ROLES,
  USER_REGISTRY_GRANTS,
  type Grant,
} from "./roles.js";
import { SIGNER_KEY } from "./signature.js";

export const YEAR_SECONDS = 365n * 86400n;
export const DEFAULT_SEND_LIMIT_RECORD = "50";
export const AGENT_ENDPOINT_KEY = "agent-endpoint[mcp]";
/** Value of the agent-endpoint[mcp] record: the hosted MCP endpoint of the API at API_PUBLIC_URL (no trailing slash). */
export const agentEndpointUrl = (apiPublicUrl: string): string => `${apiPublicUrl.replace(/\/+$/, "")}/mcp`;

/** Status enum of IPermissionedRegistry.State. */
export const STATUS = { AVAILABLE: 0, RESERVED: 1, REGISTERED: 2 } as const;

export interface RegistryState {
  status: number;
  expiry: bigint;
  latestOwner: Address;
  tokenId: bigint;
  resource: bigint;
}

/** Reads names through the Universal Resolver (fresh, no cache). */
export interface NameReader {
  getAddress(name: string): Promise<Address | null>;
  getText(name: string, key: string): Promise<string | null>;
}

export interface StepResult {
  txHashes: Record<string, Hex>;
  skipped: string[];
  gasUsed: Record<string, bigint>;
}

export interface CreateUserNameResult extends StepResult {
  registry: Address;
  tokenId: bigint;
  expiry: bigint;
  name: string;
}

export interface CreateAgentNameResult extends StepResult {
  resolver: Address;
  tokenId: bigint;
  expiry: bigint;
  name: string;
  userWallet: Address;
}

/** Every text record Nanite manages on an agent's resolver (the permission matrix rows). */
export const AGENT_TEXT_KEYS = [
  "email",
  "nanite.pubkey",
  "agent-context",
  AGENT_ENDPOINT_KEY,
  SEND_KEYS.policy,
  SEND_KEYS.allow,
  SEND_KEYS.limit,
  RETENTION_KEYS.otpTtl,
  RETENTION_KEYS.mailTtl,
  RETENTION_KEYS.extend,
  RETENTION_KEYS.extendLimit,
  SIGNER_KEY,
] as const;

export interface AgentPermissions {
  name: string;
  resolver: Address;
  account: Address;
  /** key -> can `account` call setText(key) on the agent's resolver */
  text: Record<string, boolean>;
  /** can `account` call setAddress (coin 60) */
  address: boolean;
}

export interface ResolvedAgent {
  name: string;
  address: Address | null;
  email: string | null;
  pubkey: string | null;
  sendPolicy: SendPolicy;
  agentContext: string | null;
  endpoint: string | null;
  /** The `nanite.signer` record: address whose key signs the agent's outgoing mail. */
  signer: string | null;
}

// ---------- pure helpers (exported for tests) ----------

export const labelhash = (label: string): bigint => BigInt(keccak256(toBytes(label)));
export const userRegistrySalt = (username: string): bigint =>
  BigInt(keccak256(toBytes(`nanite:user-registry:${username}:v1`)));
export const agentResolverSalt = (username: string, agentLabel: string): bigint =>
  BigInt(keccak256(toBytes(`nanite:agent-resolver:${username}:${agentLabel}:v1`)));
/** PermissionedResolverLib.resource(key) for text keys. */
export const textResource = (key: string): bigint => labelhash(key);

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
export function assertUsername(username: string): void {
  if (username.length < 3 || !LABEL_RE.test(username)) {
    throw new Error(`invalid username "${username}" (3-32 chars, a-z 0-9 and inner hyphens)`);
  }
}
export function assertAgentLabel(label: string): void {
  if (label.length < 2 || !LABEL_RE.test(label)) {
    throw new Error(`invalid agent label "${label}" (2-32 chars, a-z 0-9 and inner hyphens)`);
  }
}

/** min(requested, parentExpiry); rejects anything at or before `now` (contract reverts CannotSetPastExpiry). */
export function clampExpiry(now: bigint, requested: bigint, parentExpiry: bigint): bigint {
  const expiry = requested < parentExpiry ? requested : parentExpiry;
  if (expiry <= now) throw new Error(`expiry ${expiry} is not after now (${now}); parent expiry ${parentExpiry}`);
  return expiry;
}

export function normalizePubkeyHex(hex: string): string {
  const h = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("encryptionPublicKeyHex must be 32 bytes of hex (X25519)");
  return h;
}

export const dnsEncode = (name: string): Hex => toHex(packetToBytes(name));

// ---------- service ----------

export interface EnsService {
  fullName(username: string, agentLabel?: string): string;
  createUserName(a: { username: string; userWallet: Address; ttlSeconds?: bigint }): Promise<CreateUserNameResult>;
  createAgentName(a: {
    username: string;
    agentLabel: string;
    agentWallet: Address;
    email: string;
    encryptionPublicKeyHex: string;
    sendPolicy?: "off" | "reply-only" | "allowlist" | "any";
    ttlSeconds?: bigint;
  }): Promise<CreateAgentNameResult>;
  setSendPolicy(a: {
    username: string;
    agentLabel: string;
    policy: string;
    allow?: string[];
    limit?: number;
  }): Promise<StepResult>;
  readSendPolicy(ensName: string): Promise<SendPolicy>;
  /**
   * Operator-signed writes of the retention records (only the fields given). The agent wallet cannot write them:
   * it holds ROLE_SET_TEXT for `agent-context` only.
   */
  setRetentionPolicy(a: {
    username: string;
    agentLabel: string;
    otpTtlMinutes?: number;
    mailTtlHours?: number;
    extend?: string;
    extendLimit?: number;
  }): Promise<StepResult>;
  /** Fresh read of the four retention records; missing or invalid values fall back to the defaults (`invalid` counts the bad ones). */
  readRetentionPolicy(ensName: string): Promise<RetentionPolicy & { invalid: number }>;
  /**
   * Operator-signed `setText(nanite.signer, <checksummed address>)`. Resumable: if the record already holds
   * the address (fresh read) nothing is sent and the result lists "set:nanite.signer" under `skipped`.
   */
  publishSigner(a: { username: string; agentLabel: string; address: string }): Promise<StepResult>;
  /** Fresh read of the `nanite.signer` record (null when empty). */
  readSigner(ensName: string): Promise<string | null>;
  /**
   * Operator-signed `setText(agent-endpoint[mcp], <API_PUBLIC_URL>/mcp)`. Resumable: nothing is sent when the record
   * already holds the URL (result lists "set:agent-endpoint[mcp]" under `skipped`).
   */
  publishAgentEndpoint(a: { username: string; agentLabel: string; url?: string }): Promise<StepResult>;
  /** Fresh read of the `agent-endpoint[mcp]` record (null when empty). */
  readAgentEndpoint(ensName: string): Promise<string | null>;
  revokeAgent(a: {
    username: string;
    agentLabel: string;
    unregister?: boolean;
    agentWallet?: Address;
  }): Promise<StepResult & { unregistered: boolean }>;
  resolveAgent(ensName: string): Promise<ResolvedAgent>;
  /** Which managed records `account` may write on the agent's resolver (fresh role reads, nothing sent). */
  getAgentPermissions(ensName: string, account: Address): Promise<AgentPermissions>;
}

export function createEnsService(deps: {
  config: EnsConfig;
  io: ChainIO;
  reader: NameReader;
  /** Delay between stale-read retries (tests pass 0). */
  retryDelayMs?: number;
}): EnsService {
  const { config, io, reader } = deps;
  const retryDelayMs = deps.retryDelayMs ?? 2000;
  const c = config.contracts;
  const parentName = `${config.parentLabel}.eth`;
  const fullName = (username: string, agentLabel?: string) =>
    agentLabel ? `${agentLabel}.${username}.${parentName}` : `${username}.${parentName}`;

  const read = <T>(address: Address, abi: CallSpec["abi"], functionName: string, args: unknown[] = []) =>
    io.read({ address, abi, functionName, args }) as Promise<T>;
  const getState = (registry: Address, label: string) =>
    read<RegistryState>(registry, abis.userRegistry, "getState", [labelhash(label)]);
  const predict = (salt: bigint) => read<Address>(c.factory, abis.factory, "predictProxyAddress", [io.operator, salt]);

  const newResult = (): StepResult => ({ txHashes: {}, skipped: [], gasUsed: {} });
  const step = async (r: StepResult, label: string, call: CallSpec) => {
    const tx = await io.send(call);
    r.txHashes[label] = tx.hash;
    r.gasUsed[label] = tx.gasUsed;
    return tx;
  };

  /** Fresh lookup of a user's registry and the agent's resolver (never cached). */
  async function lookupAgent(username: string, agentLabel: string) {
    assertUsername(username);
    assertAgentLabel(agentLabel);
    const registry = await read<Address>(c.parentRegistry, abis.userRegistry, "getSubregistry", [username]);
    if (registry === zeroAddress) throw new Error(`${fullName(username)} has no registry`);
    const resolver = await read<Address>(registry, abis.userRegistry, "getResolver", [agentLabel]);
    return { registry, resolver };
  }

  async function createUserName(a: { username: string; userWallet: Address; ttlSeconds?: bigint }) {
    const { username } = a;
    assertUsername(username);
    const userWallet = getAddress(a.userWallet);
    if (userWallet === io.operator) throw new Error("userWallet must not be the operator");
    const r = newResult();

    // 1. The user's own registry (deterministic proxy).
    const salt = userRegistrySalt(username);
    const registry = getAddress(await predict(salt));
    if (!(await io.hasCode(registry))) {
      const grants: Grant[] = [
        { account: userWallet, roleBitmap: USER_REGISTRY_GRANTS.user },
        { account: io.operator, roleBitmap: USER_REGISTRY_GRANTS.operator },
      ];
      const data = encodeFunctionData({ abi: abis.userRegistry, functionName: "initialize", args: [grants] });
      await step(r, "deploy-registry", {
        address: c.factory,
        abi: abis.factory,
        functionName: "deployProxy",
        args: [c.userRegistryImpl, salt, data],
      });
      await io.waitForCode(registry);
    } else {
      r.skipped.push("deploy-registry");
      const ok = await read<boolean>(registry, abis.userRegistry, "hasRootRoles", [ALL_ROLES, userWallet]);
      if (!ok) throw new Error(`registry ${registry} exists but ${userWallet} does not hold ALL_ROLES on it`);
    }

    // 2. setParent(nanitecom registry, username) so the registry knows its canonical name.
    const parent = await read<readonly [Address, string]>(registry, abis.userRegistry, "getParent");
    if (getAddress(parent[0]) === c.parentRegistry && parent[1] === username) r.skipped.push("set-parent");
    else {
      await step(r, "set-parent", {
        address: registry,
        abi: abis.userRegistry,
        functionName: "setParent",
        args: [c.parentRegistry, username],
      });
    }

    // 3. Register username in the nanitecom registry, owned by the user, subregistry = user's registry.
    let state = await getState(c.parentRegistry, username);
    let tokenId: bigint;
    if (state.status === STATUS.AVAILABLE) {
      const now = await io.now();
      const parentState = await read<RegistryState>(c.ethRegistry, abis.ethRegistry, "getState", [
        labelhash(config.parentLabel),
      ]);
      const expiry = clampExpiry(now, now + (a.ttlSeconds ?? YEAR_SECONDS), parentState.expiry);
      const tx = await step(r, "register-username", {
        address: c.parentRegistry,
        abi: abis.userRegistry,
        functionName: "register",
        args: [username, userWallet, registry, zeroAddress, USER_NAME_ROLES, expiry],
      });
      tokenId = tx.result as bigint;
      state = { ...state, expiry, tokenId };
    } else if (state.status === STATUS.REGISTERED) {
      if (getAddress(state.latestOwner) !== userWallet) throw new Error(`username "${username}" is taken by another wallet`);
      const sub = await read<Address>(c.parentRegistry, abis.userRegistry, "getSubregistry", [username]);
      if (getAddress(sub) !== registry) throw new Error(`username "${username}" is registered with a different registry (${sub})`);
      r.skipped.push("register-username");
      tokenId = state.tokenId;
    } else {
      throw new Error(`username "${username}" is reserved or in an unexpected state (${state.status})`);
    }
    return { ...r, registry, tokenId, expiry: state.expiry, name: fullName(username) };
  }

  async function createAgentName(a: Parameters<EnsService["createAgentName"]>[0]) {
    const { username, agentLabel } = a;
    assertUsername(username);
    assertAgentLabel(agentLabel);
    const agentWallet = getAddress(a.agentWallet);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) throw new Error("invalid email");
    const pubkey = normalizePubkeyHex(a.encryptionPublicKeyHex);
    const sendPolicy = validateSendPolicyInput({ policy: a.sendPolicy ?? "reply-only" }).policy;
    const r = newResult();
    const name = fullName(username, agentLabel);

    // The user wallet is whoever currently owns the username token; they own the agent token too.
    // The public RPC can serve stale reads right after a receipt (e.g. createUserName just ran), so retry.
    let userState = await getState(c.parentRegistry, username);
    for (let i = 0; i < 10 && userState.status !== STATUS.REGISTERED; i++) {
      await new Promise((res) => setTimeout(res, retryDelayMs));
      userState = await getState(c.parentRegistry, username);
    }
    if (userState.status !== STATUS.REGISTERED) throw new Error(`${fullName(username)} is not registered`);
    const userWallet = getAddress(userState.latestOwner);
    const registry = getAddress(await read<Address>(c.parentRegistry, abis.userRegistry, "getSubregistry", [username]));
    if (registry === zeroAddress || !(await io.hasCode(registry))) throw new Error(`no registry deployed for ${fullName(username)}`);
    const canRegister = await read<boolean>(registry, abis.userRegistry, "hasRootRoles", [REGISTRY_ROLE.REGISTRAR, io.operator]);
    if (!canRegister) throw new Error(`operator lacks REGISTRAR on ${registry}`);

    // 1. The agent's own resolver proxy with initial records (grants first, then records).
    const salt = agentResolverSalt(username, agentLabel);
    const resolver = getAddress(await predict(salt));
    if (!(await io.hasCode(resolver))) {
      const dns = dnsEncode(name);
      const text = (key: string, value: string) =>
        encodeFunctionData({ abi: abis.resolver, functionName: "setText", args: [dns, key, value] });
      const calls = [
        encodeFunctionData({ abi: abis.resolver, functionName: "setAddress", args: [dns, 60n, agentWallet] }),
        text("email", a.email),
        text("nanite.pubkey", pubkey),
        text("agent-context", `Nanite agent mailbox ${name}`),
        text(AGENT_ENDPOINT_KEY, agentEndpointUrl(config.apiPublicUrl)), // the hosted MCP endpoint (Streamable HTTP, agent bearer token)
        text(SEND_KEYS.policy, sendPolicy),
        text(SEND_KEYS.allow, ""),
        text(SEND_KEYS.limit, DEFAULT_SEND_LIMIT_RECORD),
      ];
      const grants: Grant[] = [
        { account: io.operator, roleBitmap: RESOLVER_GRANTS.operator },
        { account: userWallet, roleBitmap: RESOLVER_GRANTS.user },
      ];
      const data = encodeFunctionData({ abi: abis.resolver, functionName: "initialize", args: [grants, calls] });
      await step(r, "deploy-resolver", {
        address: c.factory,
        abi: abis.factory,
        functionName: "deployProxy",
        args: [c.resolverImpl, salt, data],
      });
      await io.waitForCode(resolver);
    } else r.skipped.push("deploy-resolver");

    // 2. Register the agent label in the user's registry, owned by the user, with that resolver.
    let state = await getState(registry, agentLabel);
    let tokenId: bigint;
    if (state.status === STATUS.AVAILABLE) {
      const now = await io.now();
      const expiry = clampExpiry(now, now + (a.ttlSeconds ?? YEAR_SECONDS), userState.expiry);
      const tx = await step(r, "register-agent", {
        address: registry,
        abi: abis.userRegistry,
        functionName: "register",
        args: [agentLabel, userWallet, zeroAddress, resolver, AGENT_NAME_ROLES, expiry],
      });
      tokenId = tx.result as bigint;
      state = { ...state, expiry, tokenId };
    } else if (state.status === STATUS.REGISTERED) {
      const res = await read<Address>(registry, abis.userRegistry, "getResolver", [agentLabel]);
      if (getAddress(state.latestOwner) !== userWallet || getAddress(res) !== resolver) {
        throw new Error(`${name} already exists with a different owner or resolver`);
      }
      r.skipped.push("register-agent");
      tokenId = state.tokenId;
    } else throw new Error(`${name} is reserved or in an unexpected state (${state.status})`);

    // 3. Key-scoped setter roles for the agent wallet (allowlisted keys only).
    for (const key of AGENT_SETTER_KEYS) {
      const label = `grant:${key}`;
      const has = await read<boolean>(resolver, abis.resolver, "hasRoles", [textResource(key), RESOLVER_ROLE.SET_TEXT, agentWallet]);
      if (has) {
        r.skipped.push(label);
        continue;
      }
      const setter = encodeFunctionData({ abi: abis.resolver, functionName: "setText", args: [dnsEncode(name), key, ""] });
      await step(r, label, { address: resolver, abi: abis.resolver, functionName: "grantSetterRoles", args: [setter, agentWallet] });
    }
    return { ...r, resolver, tokenId, expiry: state.expiry, name, userWallet };
  }

  async function setSendPolicy(a: Parameters<EnsService["setSendPolicy"]>[0]) {
    const v = validateSendPolicyInput({ policy: a.policy, allow: a.allow, limit: a.limit });
    const { resolver } = await lookupAgent(a.username, a.agentLabel);
    if (resolver === zeroAddress) throw new Error("agent has no resolver");
    const dns = dnsEncode(fullName(a.username, a.agentLabel));
    const r = newResult();
    const writes: [string, string][] = [[SEND_KEYS.policy, v.policy]];
    if (v.allow !== undefined) writes.push([SEND_KEYS.allow, v.allow]);
    if (v.limit !== undefined) writes.push([SEND_KEYS.limit, v.limit]);
    for (const [key, value] of writes) {
      await step(r, `set:${key}`, { address: resolver, abi: abis.resolver, functionName: "setText", args: [dns, key, value] });
    }
    return r;
  }

  async function readSendPolicy(ensName: string) {
    const [policy, allow, limit] = await Promise.all([
      reader.getText(ensName, SEND_KEYS.policy),
      reader.getText(ensName, SEND_KEYS.allow),
      reader.getText(ensName, SEND_KEYS.limit),
    ]);
    return parseSendPolicy({ policy, allow, limit });
  }

  async function setRetentionPolicy(a: Parameters<EnsService["setRetentionPolicy"]>[0]) {
    const v = validateRetentionInput(a);
    const { resolver } = await lookupAgent(a.username, a.agentLabel);
    if (resolver === zeroAddress) throw new Error("agent has no resolver");
    const dns = dnsEncode(fullName(a.username, a.agentLabel));
    const r = newResult();
    const writes: [string, string][] = [];
    if (v.otpTtl !== undefined) writes.push([RETENTION_KEYS.otpTtl, v.otpTtl]);
    if (v.mailTtl !== undefined) writes.push([RETENTION_KEYS.mailTtl, v.mailTtl]);
    if (v.extend !== undefined) writes.push([RETENTION_KEYS.extend, v.extend]);
    if (v.extendLimit !== undefined) writes.push([RETENTION_KEYS.extendLimit, v.extendLimit]);
    for (const [key, value] of writes) {
      await step(r, `set:${key}`, { address: resolver, abi: abis.resolver, functionName: "setText", args: [dns, key, value] });
    }
    return r;
  }

  async function readRetentionPolicy(ensName: string) {
    const [otpTtl, mailTtl, extend, extendLimit] = await Promise.all([
      reader.getText(ensName, RETENTION_KEYS.otpTtl),
      reader.getText(ensName, RETENTION_KEYS.mailTtl),
      reader.getText(ensName, RETENTION_KEYS.extend),
      reader.getText(ensName, RETENTION_KEYS.extendLimit),
    ]);
    const { policy, invalid } = parseRetention({ otpTtl, mailTtl, extend, extendLimit });
    return { ...policy, invalid };
  }

  async function readSigner(ensName: string) {
    const v = (await reader.getText(ensName, SIGNER_KEY))?.trim();
    return v ? v : null;
  }

  async function publishSigner(a: Parameters<EnsService["publishSigner"]>[0]) {
    if (!isAddress(a.address)) throw new Error("signer address is not a valid address");
    const address = getAddress(a.address);
    const { resolver } = await lookupAgent(a.username, a.agentLabel);
    if (resolver === zeroAddress) throw new Error("agent has no resolver");
    const name = fullName(a.username, a.agentLabel);
    const r = newResult();
    const label = `set:${SIGNER_KEY}`;
    const current = await readSigner(name).catch(() => null);
    if (current && isAddress(current, { strict: false }) && getAddress(current) === address) {
      r.skipped.push(label);
      return r;
    }
    await step(r, label, { address: resolver, abi: abis.resolver, functionName: "setText", args: [dnsEncode(name), SIGNER_KEY, address] });
    return r;
  }

  async function readAgentEndpoint(ensName: string) {
    const v = (await reader.getText(ensName, AGENT_ENDPOINT_KEY))?.trim();
    return v ? v : null;
  }

  async function publishAgentEndpoint(a: Parameters<EnsService["publishAgentEndpoint"]>[0]) {
    const url = a.url ?? agentEndpointUrl(config.apiPublicUrl);
    const { resolver } = await lookupAgent(a.username, a.agentLabel);
    if (resolver === zeroAddress) throw new Error("agent has no resolver");
    const name = fullName(a.username, a.agentLabel);
    const r = newResult();
    const label = `set:${AGENT_ENDPOINT_KEY}`;
    if ((await readAgentEndpoint(name).catch(() => null)) === url) {
      r.skipped.push(label);
      return r;
    }
    await step(r, label, { address: resolver, abi: abis.resolver, functionName: "setText", args: [dnsEncode(name), AGENT_ENDPOINT_KEY, url] });
    return r;
  }

  async function revokeAgent(a: Parameters<EnsService["revokeAgent"]>[0]) {
    let { registry, resolver } = await lookupAgent(a.username, a.agentLabel);
    // The public RPC can serve a stale zero resolver right after the agent was registered: re-read a few times.
    for (let i = 0; i < 5 && resolver === zeroAddress; i++) {
      await new Promise((res) => setTimeout(res, retryDelayMs));
      ({ registry, resolver } = await lookupAgent(a.username, a.agentLabel));
    }
    const name = fullName(a.username, a.agentLabel);
    const r = newResult();
    if (resolver === zeroAddress) {
      // Already unregistered (the registry forgets the resolver): nothing left to revoke, so stay idempotent.
      const st = await getState(registry, a.agentLabel);
      if (st.status === STATUS.AVAILABLE && st.latestOwner !== zeroAddress) {
        r.skipped.push(...AGENT_SETTER_KEYS.map((k) => `revoke:${k}`), ...(a.unregister ? ["unregister"] : []));
        return { ...r, unregistered: false };
      }
      throw new Error(`${name} has no resolver`);
    }
    const wallet = a.agentWallet ?? (await reader.getAddress(name));
    if (!wallet || !isAddress(wallet)) throw new Error(`cannot determine agent wallet for ${name}`);
    for (const key of AGENT_SETTER_KEYS) {
      const label = `revoke:${key}`;
      const resource = textResource(key);
      const has = await read<boolean>(resolver, abis.resolver, "hasRoles", [resource, RESOLVER_ROLE.SET_TEXT, wallet]);
      if (!has) {
        r.skipped.push(label);
        continue;
      }
      await step(r, label, {
        address: resolver,
        abi: abis.resolver,
        functionName: "revokeRoles",
        args: [resource, RESOLVER_ROLE.SET_TEXT, wallet],
      });
    }
    let unregistered = false;
    if (a.unregister) {
      const st = await getState(registry, a.agentLabel);
      if (st.status === STATUS.REGISTERED) {
        try {
          await step(r, "unregister", {
            address: registry,
            abi: abis.userRegistry,
            functionName: "unregister",
            args: [labelhash(a.agentLabel)],
          });
          unregistered = true;
        } catch (e) {
          // A stale read can still show REGISTERED right after an earlier unregister; the contract says expired.
          if (!String(e).includes("LabelExpired")) throw e;
          r.skipped.push("unregister");
        }
      } else r.skipped.push("unregister");
    }
    return { ...r, unregistered };
  }

  async function resolveAgent(ensName: string): Promise<ResolvedAgent> {
    const [address, email, pubkey, agentContext, endpoint, sendPolicy, signer] = await Promise.all([
      reader.getAddress(ensName),
      reader.getText(ensName, "email"),
      reader.getText(ensName, "nanite.pubkey"),
      reader.getText(ensName, "agent-context"),
      reader.getText(ensName, AGENT_ENDPOINT_KEY),
      readSendPolicy(ensName),
      readSigner(ensName),
    ]);
    return { name: ensName, address, email, pubkey, sendPolicy, agentContext, endpoint, signer };
  }

  async function getAgentPermissions(ensName: string, accountIn: Address): Promise<AgentPermissions> {
    const account = getAddress(accountIn);
    const suffix = `.${parentName}`;
    const labels = ensName.toLowerCase().endsWith(suffix) ? ensName.slice(0, -suffix.length).split(".") : [];
    const [agentLabel, username] = labels;
    if (labels.length !== 2 || !agentLabel || !username) throw new Error(`"${ensName}" is not <agent>.<user>${suffix}`);
    const { resolver } = await lookupAgent(username, agentLabel);
    if (resolver === zeroAddress) throw new Error(`${ensName} has no resolver`);
    // hasRoles covers the key's own resource and (in EAC) root roles; also check root explicitly to be safe.
    const can = async (resource: bigint, role: bigint) =>
      (await read<boolean>(resolver, abis.resolver, "hasRoles", [resource, role, account])) ||
      (await read<boolean>(resolver, abis.resolver, "hasRootRoles", [role, account]));
    const text: Record<string, boolean> = {};
    for (const key of AGENT_TEXT_KEYS) text[key] = await can(textResource(key), RESOLVER_ROLE.SET_TEXT);
    const address = await read<boolean>(resolver, abis.resolver, "hasRootRoles", [RESOLVER_ROLE.SET_ADDRESS, account]);
    return { name: ensName, resolver, account, text, address };
  }

  return { fullName, createUserName, createAgentName, setSendPolicy, readSendPolicy, setRetentionPolicy, readRetentionPolicy, publishSigner, readSigner, publishAgentEndpoint, readAgentEndpoint, revokeAgent, resolveAgent, getAgentPermissions };
}

/** Production wiring: viem public client (cacheTime 0) + operator wallet + Universal Resolver reads. */
export function createEnsServiceFromConfig(config: EnsConfig): EnsService {
  const client = createPublicEnsClient(config);
  const io = createViemChainIO(config, client);
  const opts = { universalResolverAddress: config.contracts.universalResolver } as const;
  const reader: NameReader = {
    getAddress: async (name) => {
      const a = await client.getEnsAddress({ name, ...opts });
      return a ? getAddress(a) : null;
    },
    getText: async (name, key) => (await client.getEnsText({ name, key, ...opts })) ?? null,
  };
  return createEnsService({ config, io, reader });
}
