// T2.2 done-when as an automated, opt-in live test on Sepolia. SENDS REAL TRANSACTIONS.
//   LIVE_ENS=1 docker compose run --rm tools npx vitest run --root packages/ens test/ens.live.test.ts
// Needs OPERATOR_PRIVATE_KEY, SEPOLIA_RPC_URL, TEST_USER_PRIVATE_KEY, TEST_SEED_MNEMONIC in the environment.
// Resumable: every create step is skipped when already done on-chain. Keys are never printed.
import { appendFileSync } from "node:fs";
import { createWalletClient, getAddress, http, keccak256, toBytes, type Address, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { beforeAll, describe, expect, it } from "vitest";
import {
  abis,
  AGENT_TEXT_KEYS,
  createEnsServiceFromConfig,
  createPublicEnsClient,
  dnsEncode,
  errText,
  labelhash,
  loadEnsConfig,
  REGISTRY_ROLE,
  SEND_KEYS,
  STATUS,
  type EnsService,
  type RegistryState,
} from "../src/index.js";

const LIVE = process.env.LIVE_ENS === "1";
const USERNAME = "t22test";
const ALEX = "alex";
const BOB = "bob";
const TIMEOUT = 600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EAC = /EACUnauthorizedAccountRoles/;

describe.skipIf(!LIVE)("T2.2 live: agent records, permissions, revoke (Sepolia)", () => {
  let svc: EnsService;
  let client: ReturnType<typeof createPublicEnsClient>;
  let userAcct: ReturnType<typeof privateKeyToAccount>;
  let agent0: ReturnType<typeof mnemonicToAccount>;
  let agent1: ReturnType<typeof mnemonicToAccount>;
  let alexName: string;
  let bobName: string;
  let alexResolver: Address;
  let userRegistry: Address;
  let parentRegistry: Address;
  let universalResolver: Address;
  const txs: Record<string, string> = {};

  const note = (line: string) => {
    // Machine-readable trail for live-check.md; never contains keys.
    appendFileSync(new URL("../live-t22.log", import.meta.url), `${new Date().toISOString()} ${line}\n`);
  };
  const record = (label: string, r: { txHashes: Record<string, Hex>; gasUsed: Record<string, bigint> }) => {
    for (const [k, h] of Object.entries(r.txHashes)) {
      txs[`${label}:${k}`] = h;
      note(`TX ${label}:${k} ${h} gas=${r.gasUsed[k]}`);
    }
  };
  const sim = async (resolver: Address, fn: string, args: unknown[], account: Address) => {
    try {
      await client.simulateContract({ address: resolver, abi: abis.resolver, functionName: fn, args, account } as never);
      return "OK";
    } catch (e) {
      return `REVERT ${errText(e)}`;
    }
  };
  /** Poll a simulation until it matches (stale public RPC right after a receipt). */
  const simUntil = async (resolver: Address, fn: string, args: unknown[], account: Address, want: (s: string) => boolean) => {
    let s = await sim(resolver, fn, args, account);
    for (let i = 0; i < 15 && !want(s); i++) {
      await sleep(3000);
      s = await sim(resolver, fn, args, account);
    }
    return s;
  };
  const pollText = async (name: string, key: string, want: (v: string | null) => boolean) => {
    let v: string | null = null;
    for (let i = 0; i < 20; i++) {
      v = (await client.getEnsText({ name, key, universalResolverAddress: universalResolver })) ?? null;
      if (want(v)) break;
      await sleep(3000);
    }
    return v;
  };

  beforeAll(() => {
    const config = loadEnsConfig();
    const seed = process.env.TEST_SEED_MNEMONIC;
    const userKey = process.env.TEST_USER_PRIVATE_KEY;
    if (!seed || !userKey) throw new Error("TEST_SEED_MNEMONIC and TEST_USER_PRIVATE_KEY are required");
    svc = createEnsServiceFromConfig(config);
    client = createPublicEnsClient(config);
    userAcct = privateKeyToAccount(userKey as Hex);
    agent0 = mnemonicToAccount(seed, { addressIndex: 0 });
    agent1 = mnemonicToAccount(seed, { addressIndex: 1 });
    alexName = svc.fullName(USERNAME, ALEX);
    bobName = svc.fullName(USERNAME, BOB);
    parentRegistry = config.contracts.parentRegistry;
    universalResolver = config.contracts.universalResolver;
    note(`--- run start user=${userAcct.address} agent0=${agent0.address} agent1=${agent1.address}`);
  });

  it("a. creates the user name and agent alex (resumable)", async () => {
    const user = await svc.createUserName({ username: USERNAME, userWallet: userAcct.address });
    record("createUserName", user);
    userRegistry = user.registry;
    const pubkey = keccak256(toBytes(`nanite:live-t22:${alexName}`)).slice(2);
    const alex = await svc.createAgentName({
      username: USERNAME,
      agentLabel: ALEX,
      agentWallet: agent0.address,
      email: `${ALEX}.${USERNAME}@nanite.test`,
      encryptionPublicKeyHex: pubkey,
    });
    record("createAgentName(alex)", alex);
    alexResolver = alex.resolver;
    expect(alex.userWallet).toBe(userAcct.address);
    note(`names ${user.name} registry=${user.registry} ${alexName} resolver=${alex.resolver}`);
  }, TIMEOUT);

  it("b. resolves addr, email, pubkey, agent-context, endpoint and send policy via UniversalResolverV2", async () => {
    let r = await svc.resolveAgent(alexName);
    for (let i = 0; i < 20 && !r.address; i++) {
      await sleep(3000);
      r = await svc.resolveAgent(alexName);
    }
    expect(r.address).toBe(agent0.address);
    expect(r.email).toBe(`${ALEX}.${USERNAME}@nanite.test`);
    expect(r.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(r.endpoint).toMatch(/\/mcp$/);
    expect(r.agentContext).toBeTruthy();
    expect(r.sendPolicy).toEqual({ policy: "reply-only", allow: [], limit: 50 });
    // Raw records too (parsing is fail-closed, so also assert the strings themselves).
    expect(await pollText(alexName, SEND_KEYS.policy, (v) => v === "reply-only")).toBe("reply-only");
    expect(await pollText(alexName, SEND_KEYS.limit, (v) => v === "50")).toBe("50");
    const allow = (await client.getEnsText({ name: alexName, key: SEND_KEYS.allow, universalResolverAddress: universalResolver })) ?? "";
    expect(allow).toBe("");
    note(`resolved ${JSON.stringify(r)}`);
  }, TIMEOUT);

  it("c. agent 0 SENDS setText(agent-context) and the new value resolves", async () => {
    const value = `t22 agent-context ${new Date().toISOString()}`;
    const dns = dnsEncode(alexName);
    const okSim = await simUntil(alexResolver, "setText", [dns, "agent-context", value], agent0.address, (s) => s === "OK");
    expect(okSim).toBe("OK"); // simulate before every send
    const wallet = createWalletClient({ account: agent0, chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
    const { request } = await client.simulateContract({
      address: alexResolver,
      abi: abis.resolver,
      functionName: "setText",
      args: [dns, "agent-context", value],
      account: agent0,
    } as never);
    const hash = await wallet.writeContract(request as never);
    const rc = await client.waitForTransactionReceipt({ hash });
    expect(rc.status).toBe("success");
    txs["agent0 setText(agent-context)"] = hash;
    note(`TX agent0 setText(agent-context) ${hash} gas=${rc.gasUsed}`);
    expect(await pollText(alexName, "agent-context", (v) => v === value)).toBe(value);
  }, TIMEOUT);

  it("d. agent 0 cannot set email, nanite.send, or addr(60) (EACUnauthorizedAccountRoles)", async () => {
    const dns = dnsEncode(alexName);
    const results = {
      email: await sim(alexResolver, "setText", [dns, "email", "evil@x.test"], agent0.address),
      "nanite.send": await sim(alexResolver, "setText", [dns, SEND_KEYS.policy, "any"], agent0.address),
      "addr(60)": await sim(alexResolver, "setAddress", [dns, 60n, agent0.address], agent0.address),
    };
    note(`agent0 negative sims ${JSON.stringify(results)}`);
    for (const v of Object.values(results)) expect(v).toMatch(EAC);
    // The helper agrees with the simulations (and is what the dashboard matrix uses).
    const perm = await svc.getAgentPermissions(alexName, agent0.address);
    expect(Object.entries(perm.text).filter(([, v]) => v).map(([k]) => k)).toEqual(["agent-context"]);
    expect(perm.address).toBe(false);
    expect(Object.keys(perm.text).sort()).toEqual([...AGENT_TEXT_KEYS].sort());
    for (const who of [userAcct.address]) {
      const p = await svc.getAgentPermissions(alexName, who);
      expect(Object.values(p.text).every(Boolean)).toBe(true);
      expect(p.address).toBe(true);
    }
    note(`getAgentPermissions agent0=${JSON.stringify(perm.text)} addr=${perm.address}`);
  }, TIMEOUT);

  it("e. the user wallet can renew its own name (ROLE_RENEW); a stranger cannot", async () => {
    const st = await client.readContract({
      address: parentRegistry,
      abi: abis.userRegistry,
      functionName: "getState",
      args: [labelhash(USERNAME)],
    }) as RegistryState;
    expect(st.status).toBe(STATUS.REGISTERED);
    const has = await client.readContract({
      address: parentRegistry,
      abi: abis.userRegistry,
      functionName: "hasRoles",
      args: [st.resource, REGISTRY_ROLE.RENEW, userAcct.address],
    });
    expect(has).toBe(true);
    const renewSim = async (account: Address) => {
      try {
        await client.simulateContract({
          address: parentRegistry,
          abi: abis.userRegistry,
          functionName: "renew",
          args: [labelhash(USERNAME), st.expiry + 86400n],
          account,
        } as never);
        return "OK";
      } catch (e) {
        return `REVERT ${errText(e)}`;
      }
    };
    const userRenew = await renewSim(userAcct.address);
    const strangerRenew = await renewSim(agent0.address);
    note(`renew sim user=${userRenew} stranger(agent0)=${strangerRenew} expiry=${st.expiry}`);
    expect(userRenew).toBe("OK");
    expect(strangerRenew).toMatch(EAC);
  }, TIMEOUT);

  it("f. revokeAgent removes agent 0's role; idempotent", async () => {
    const r1 = await svc.revokeAgent({ username: USERNAME, agentLabel: ALEX, agentWallet: agent0.address });
    record("revokeAgent(alex)", r1);
    const dns = dnsEncode(alexName);
    const after = await simUntil(alexResolver, "setText", [dns, "agent-context", "x"], agent0.address, (s) => EAC.test(s));
    note(`agent0 setText(agent-context) after revoke: ${after}`);
    expect(after).toMatch(EAC);
    // Wait until the (possibly stale) node shows the revoke before calling again.
    for (let i = 0; i < 15; i++) {
      const p = await svc.getAgentPermissions(alexName, agent0.address);
      if (!Object.values(p.text).some(Boolean)) break;
      await sleep(3000);
    }
    const r2 = await svc.revokeAgent({ username: USERNAME, agentLabel: ALEX, agentWallet: agent0.address });
    expect(r2.txHashes).toEqual({});
    expect(r2.skipped).toContain("revoke:agent-context");
    const perm = await svc.getAgentPermissions(alexName, agent0.address);
    expect(Object.values(perm.text).some(Boolean)).toBe(false);
  }, TIMEOUT);

  it("g. revokeAgent({unregister:true}) on throwaway agent bob: the name stops resolving", async () => {
    const bob = await svc.createAgentName({
      username: USERNAME,
      agentLabel: BOB,
      agentWallet: agent1.address, // 0 ETH: only the operator sends
      email: `${BOB}.${USERNAME}@nanite.test`,
      encryptionPublicKeyHex: keccak256(toBytes(`nanite:live-t22:${bobName}`)).slice(2),
    });
    record("createAgentName(bob)", bob);
    let resolved = await svc.resolveAgent(bobName);
    for (let i = 0; i < 20 && !resolved.address; i++) {
      await sleep(3000);
      resolved = await svc.resolveAgent(bobName);
    }
    expect(resolved.address).toBe(agent1.address);
    const rv = await svc.revokeAgent({ username: USERNAME, agentLabel: BOB, agentWallet: agent1.address, unregister: true });
    record("revokeAgent(bob,unregister)", rv);
    expect(rv.unregistered).toBe(true);
    let addr: Address | null = resolved.address;
    for (let i = 0; i < 20 && addr; i++) {
      await sleep(3000);
      addr = await client
        .getEnsAddress({ name: bobName, universalResolverAddress: universalResolver })
        .then((a) => (a ? getAddress(a) : null))
        .catch(() => null);
    }
    note(`bob resolves after unregister: ${addr}`);
    expect(addr).toBeNull();
    // Idempotent: either a clean no-op, or (if the registry also forgets latestOwner) "no resolver".
    const again = await svc
      .revokeAgent({ username: USERNAME, agentLabel: BOB, agentWallet: agent1.address, unregister: true })
      .then((x) => ({ ok: true as const, x }), (e: unknown) => ({ ok: false as const, e: String(e) }));
    note(`bob second revoke: ${JSON.stringify(again, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    if (again.ok) expect(again.x.txHashes).toEqual({});
    else expect(again.e).toMatch(/no resolver/);
    note(`all txs ${JSON.stringify(txs)}`);
  }, TIMEOUT);
});
