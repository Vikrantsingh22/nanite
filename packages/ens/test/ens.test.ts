import { describe, expect, it } from "vitest";
import { getAddress, keccak256, stringToHex, toBytes, zeroAddress } from "viem";
import rolesJson from "../../../config/roles.json" with { type: "json" };

const RR_UPGRADE = BigInt(rolesJson.registry.ROLE_UPGRADE);
import {
  AGENT_NAME_ROLES,
  AGENT_SETTER_KEYS,
  ALL_ROLES,
  RESOLVER_GRANTS,
  RESOLVER_ROLE,
  REGISTRY_ROLE,
  USER_NAME_ROLES,
  USER_REGISTRY_GRANTS,
} from "../src/roles.js";
import {
  DEFAULT_SEND_LIMIT,
  parseSendPolicy,
  SEND_KEYS,
  validateSendPolicyInput,
} from "../src/policy.js";
import {
  AGENT_TEXT_KEYS,
  agentEndpointUrl,
  agentResolverSalt,
  clampExpiry,
  createEnsService,
  labelhash,
  userRegistrySalt,
  YEAR_SECONDS,
} from "../src/service.js";
import { AGENT, config, createFakeChain, emptyReader, NOW, OPERATOR, PARENT_EXPIRY, PUBKEY, USER } from "./helpers.js";

describe("expiry clamp", () => {
  it("uses the requested expiry when it is before the parent's", () => {
    expect(clampExpiry(100n, 200n, 500n)).toBe(200n);
  });
  it("clamps to the parent expiry", () => {
    expect(clampExpiry(100n, 900n, 500n)).toBe(500n);
  });
  it("rejects expiry <= now (including a parent that already expired)", () => {
    expect(() => clampExpiry(100n, 100n, 500n)).toThrow();
    expect(() => clampExpiry(100n, 900n, 100n)).toThrow();
    expect(() => clampExpiry(100n, 900n, 50n)).toThrow();
  });
});

describe("role allowlists", () => {
  it("USER_NAME_ROLES equals D3 from T0.4 plus a plain RENEW", () => {
    expect(USER_NAME_ROLES).toBe(0x1110000000000000000000000000000001100000n | 0x10000n);
    expect(USER_NAME_ROLES & REGISTRY_ROLE.RENEW).toBe(REGISTRY_ROLE.RENEW);
    expect(USER_NAME_ROLES & (REGISTRY_ROLE.RENEW << 128n)).toBe(0n); // no RENEW admin
  });
  it("USER_NAME_ROLES has no UPGRADE, UNREGISTER or REGISTRAR (nor their admins)", () => {
    const UPGRADE = RR_UPGRADE;
    for (const r of [UPGRADE, REGISTRY_ROLE.UNREGISTER, REGISTRY_ROLE.REGISTRAR]) {
      expect(USER_NAME_ROLES & r).toBe(0n);
      expect(USER_NAME_ROLES & (r << 128n)).toBe(0n);
    }
  });
  it("user registry grants: user ALL_ROLES; operator only the four named roles, no admin/upgrade", () => {
    expect(USER_REGISTRY_GRANTS.user).toBe(ALL_ROLES);
    expect(USER_REGISTRY_GRANTS.operator).toBe(
      REGISTRY_ROLE.REGISTRAR | REGISTRY_ROLE.RENEW | REGISTRY_ROLE.SET_PARENT | REGISTRY_ROLE.UNREGISTER,
    );
    expect(USER_REGISTRY_GRANTS.operator >> 128n).toBe(0n); // no admin roles
    expect(USER_REGISTRY_GRANTS.operator).toBe(0x1101n | 0x10000n); // 0x11101
  });
  it("agent name roles: user can set resolver and transfer, no subregistry", () => {
    expect(AGENT_NAME_ROLES & REGISTRY_ROLE.SET_SUBREGISTRY).toBe(0n);
    expect(AGENT_NAME_ROLES & REGISTRY_ROLE.SET_RESOLVER).not.toBe(0n);
  });
  it("resolver grants: SET_TEXT|SET_ADDRESS + admins, never UPGRADE", () => {
    const expected = 0x11n | (0x11n << 128n);
    expect(RESOLVER_GRANTS.operator).toBe(expected);
    expect(RESOLVER_GRANTS.user).toBe(expected);
    expect(RESOLVER_GRANTS.operator & (0x1n << 124n)).toBe(0n);
    expect(RESOLVER_GRANTS.operator & (0x1n << 252n)).toBe(0n);
  });
  it("the agent can only ever set agent-context, never a send-policy key", () => {
    expect([...AGENT_SETTER_KEYS]).toEqual(["agent-context"]);
    for (const k of Object.values(SEND_KEYS)) expect((AGENT_SETTER_KEYS as readonly string[]).includes(k)).toBe(false);
  });
});

describe("salts", () => {
  it("are deterministic and distinct per username/agent", () => {
    expect(userRegistrySalt("alice")).toBe(BigInt(keccak256(toBytes("nanite:user-registry:alice:v1"))));
    expect(agentResolverSalt("alice", "bot")).toBe(BigInt(keccak256(toBytes("nanite:agent-resolver:alice:bot:v1"))));
    expect(userRegistrySalt("alice")).toBe(userRegistrySalt("alice"));
    expect(userRegistrySalt("alice")).not.toBe(userRegistrySalt("bob"));
    expect(agentResolverSalt("alice", "a")).not.toBe(agentResolverSalt("alice", "b"));
  });
});

describe("send policy parsing", () => {
  it("defaults when records are missing", () => {
    expect(parseSendPolicy({})).toEqual({ policy: "reply-only", allow: [], limit: DEFAULT_SEND_LIMIT });
  });
  it("parses valid records", () => {
    expect(parseSendPolicy({ policy: "allowlist", allow: "Bob@x.com, @corp.io, alex.eth", limit: "7" })).toEqual({
      policy: "allowlist",
      allow: ["bob@x.com", "@corp.io", "alex.eth"],
      limit: 7,
    });
  });
  it("fails closed on garbage", () => {
    expect(parseSendPolicy({ policy: "ANY!", allow: "not valid", limit: "-1" })).toEqual({ policy: "off", allow: [], limit: 0 });
    expect(parseSendPolicy({ policy: "any", limit: "99999" }).limit).toBe(0);
  });
  it("validates setter input", () => {
    expect(validateSendPolicyInput({ policy: "any", allow: [" A@b.co "], limit: 3 })).toEqual({ policy: "any", allow: "a@b.co", limit: "3" });
    expect(() => validateSendPolicyInput({ policy: "sometimes" })).toThrow();
    expect(() => validateSendPolicyInput({ policy: "any", allow: ["nope"] })).toThrow();
    expect(() => validateSendPolicyInput({ policy: "any", limit: 1.5 })).toThrow();
    expect(() => validateSendPolicyInput({ policy: "any", limit: 10_001 })).toThrow();
  });
});

function setup() {
  const fake = createFakeChain();
  const svc = createEnsService({ config, io: fake.io, reader: emptyReader, retryDelayMs: 0 });
  return { fake, svc };
}
const agentArgs = {
  username: "alice",
  agentLabel: "bot",
  agentWallet: AGENT,
  email: "bot@alice.example.test",
  encryptionPublicKeyHex: PUBKEY,
};

describe("createUserName", () => {
  it("deploys, sets parent, registers with clamped expiry, then resumes as a no-op", async () => {
    const { fake, svc } = setup();
    const r1 = await svc.createUserName({ username: "alice", userWallet: USER });
    expect(Object.keys(r1.txHashes)).toEqual(["deploy-registry", "set-parent", "register-username"]);
    expect(r1.skipped).toEqual([]);
    expect(r1.expiry).toBe(PARENT_EXPIRY); // now + 1y > parent expiry
    const reg = fake.sent.find((s) => s.fn === "register")!;
    expect(reg.args[1]).toBe(USER);
    expect(reg.args[2]).toBe(r1.registry);
    expect(reg.args[4]).toBe(USER_NAME_ROLES);
    const r2 = await svc.createUserName({ username: "alice", userWallet: USER });
    expect(r2.txHashes).toEqual({});
    expect(r2.skipped).toEqual(["deploy-registry", "set-parent", "register-username"]);
    expect(r2.tokenId).toBe(r1.tokenId);
    expect(fake.sent.length).toBe(3);
  });
  it("resumes after a partial run (registry deployed, nothing else)", async () => {
    const { fake, svc } = setup();
    await svc.createUserName({ username: "alice", userWallet: USER });
    // simulate a crash after deploy by clearing the registered state
    for (const k of [...fake.states.keys()]) if (!k.startsWith(config.contracts.ethRegistry)) fake.states.delete(k);
    const r = await svc.createUserName({ username: "alice", userWallet: USER });
    expect(r.skipped).toContain("deploy-registry");
    expect(Object.keys(r.txHashes)).toEqual(["register-username"]);
  });
  it("rejects a username owned by someone else and bad names", async () => {
    const { svc } = setup();
    await svc.createUserName({ username: "alice", userWallet: USER });
    await expect(svc.createUserName({ username: "alice", userWallet: AGENT })).rejects.toThrow();
    await expect(svc.createUserName({ username: "Al", userWallet: USER })).rejects.toThrow(/invalid username/);
    await expect(svc.createUserName({ username: "alice", userWallet: OPERATOR })).rejects.toThrow(/operator/);
  });
  it("deploys the registry with exactly the allowlisted grants", async () => {
    const { fake, svc } = setup();
    await svc.createUserName({ username: "alice", userWallet: USER });
    const deploy = fake.sent.find((s) => s.fn === "deployProxy")!;
    expect(deploy.args[0]).toBe(config.contracts.userRegistryImpl);
    expect(deploy.args[1]).toBe(userRegistrySalt("alice"));
  });
});

describe("createAgentName", () => {
  it("requires the user name first", async () => {
    const { svc } = setup();
    await expect(svc.createAgentName(agentArgs)).rejects.toThrow(/not registered/);
  });
  it("deploys resolver, registers (expiry clamped to the user name), grants setter roles; resumable", async () => {
    const { fake, svc } = setup();
    const u = await svc.createUserName({ username: "alice", userWallet: USER });
    const r1 = await svc.createAgentName(agentArgs);
    expect(Object.keys(r1.txHashes)).toEqual(["deploy-resolver", "register-agent", "grant:agent-context"]);
    expect(r1.expiry).toBe(u.expiry);
    expect(r1.expiry).toBeGreaterThan(NOW);
    expect(r1.expiry).toBeLessThanOrEqual(NOW + YEAR_SECONDS);
    const reg = fake.sent.filter((s) => s.fn === "register").at(-1)!;
    expect(reg.args[1]).toBe(USER); // owned by the user, not the agent
    expect(reg.args[3]).toBe(r1.resolver);
    expect(reg.args[4]).toBe(AGENT_NAME_ROLES);
    const n = fake.sent.length;
    const r2 = await svc.createAgentName(agentArgs);
    expect(r2.txHashes).toEqual({});
    expect(r2.skipped).toEqual(["deploy-resolver", "register-agent", "grant:agent-context"]);
    expect(fake.sent.length).toBe(n);
  });
  it("only grants setter roles for allowlisted keys", async () => {
    const { fake, svc } = setup();
    await svc.createUserName({ username: "alice", userWallet: USER });
    await svc.createAgentName(agentArgs);
    expect(fake.sent.filter((s) => s.fn === "grantSetterRoles").length).toBe(AGENT_SETTER_KEYS.length);
  });
  it("validates inputs", async () => {
    const { svc } = setup();
    await svc.createUserName({ username: "alice", userWallet: USER });
    await expect(svc.createAgentName({ ...agentArgs, encryptionPublicKeyHex: "zz" })).rejects.toThrow();
    await expect(svc.createAgentName({ ...agentArgs, email: "nope" })).rejects.toThrow();
    await expect(svc.createAgentName({ ...agentArgs, agentLabel: "Bad Label" })).rejects.toThrow();
  });
});

describe("getAgentPermissions", () => {
  const NAME = "bot.alice.nanitecom.eth";
  it("agent wallet: only agent-context; operator and user: every record and addr", async () => {
    const { fake, svc } = setup();
    await svc.createUserName({ username: "alice", userWallet: USER });
    await svc.createAgentName(agentArgs);
    const agent = await svc.getAgentPermissions(NAME, AGENT);
    expect(Object.keys(agent.text).sort()).toEqual([...AGENT_TEXT_KEYS].sort());
    expect(Object.entries(agent.text).filter(([, v]) => v).map(([k]) => k)).toEqual(["agent-context"]);
    expect(agent.address).toBe(false);
    for (const who of [OPERATOR, USER]) {
      const p = await svc.getAgentPermissions(NAME, who);
      expect(Object.values(p.text).every(Boolean)).toBe(true);
      expect(p.address).toBe(true);
    }
    expect(fake.sent.some((s) => s.fn === "setText")).toBe(false); // read-only
  });
  it("after revoke the agent can set nothing; a stranger never can", async () => {
    const { svc } = setup();
    await svc.createUserName({ username: "alice", userWallet: USER });
    await svc.createAgentName(agentArgs);
    await svc.revokeAgent({ username: "alice", agentLabel: "bot" });
    const p = await svc.getAgentPermissions(NAME, AGENT);
    expect(Object.values(p.text).some(Boolean)).toBe(false);
    const stranger = await svc.getAgentPermissions(NAME, getAddress("0x000000000000000000000000000000000000dEaD"));
    expect(Object.values(stranger.text).some(Boolean)).toBe(false);
    expect(stranger.address).toBe(false);
  });
  it("rejects malformed names and unknown users", async () => {
    const { svc } = setup();
    await expect(svc.getAgentPermissions("alice.nanitecom.eth", AGENT)).rejects.toThrow(/not <agent>/);
    await expect(svc.getAgentPermissions("x.y.example.eth", AGENT)).rejects.toThrow();
    await expect(svc.getAgentPermissions("bot.nobody.nanitecom.eth", AGENT)).rejects.toThrow(/no registry/);
  });
});

describe("setSendPolicy / revokeAgent", () => {
  it("setSendPolicy writes only the fields given, using the live resolver", async () => {
    const { fake, svc } = setup();
    await svc.createUserName({ username: "alice", userWallet: USER });
    const a = await svc.createAgentName(agentArgs);
    const r = await svc.setSendPolicy({ username: "alice", agentLabel: "bot", policy: "allowlist", allow: ["x@y.com"] });
    expect(Object.keys(r.txHashes)).toEqual(["set:nanite.send", "set:nanite.send-allow"]);
    const last = fake.sent.at(-1)!;
    expect(last.address).toBe(a.resolver);
    expect(last.args[2]).toBe("x@y.com");
    await expect(svc.setSendPolicy({ username: "alice", agentLabel: "bot", policy: "bogus" })).rejects.toThrow();
  });
  it("publishSigner writes nanite.signer (checksummed) on the agent resolver and skips when already set", async () => {
    const fake = createFakeChain();
    const records = new Map<string, string>();
    const reader = { getAddress: async () => AGENT, getText: async (n: string, k: string) => records.get(`${n}|${k}`) ?? null };
    const svc = createEnsService({ config, io: fake.io, reader, retryDelayMs: 0 });
    await svc.createUserName({ username: "alice", userWallet: USER });
    const a = await svc.createAgentName(agentArgs);
    const lower = AGENT.toLowerCase();
    const r = await svc.publishSigner({ username: "alice", agentLabel: "bot", address: lower });
    expect(Object.keys(r.txHashes)).toEqual(["set:nanite.signer"]);
    const last = fake.sent.at(-1)!;
    expect(last.fn).toBe("setText");
    expect(last.address).toBe(a.resolver);
    expect(last.args[1]).toBe("nanite.signer");
    expect(last.args[2]).toBe(AGENT); // checksummed
    records.set("bot.alice.nanitecom.eth|nanite.signer", AGENT);
    const n = fake.sent.length;
    const again = await svc.publishSigner({ username: "alice", agentLabel: "bot", address: AGENT });
    expect(again.skipped).toEqual(["set:nanite.signer"]);
    expect(fake.sent.length).toBe(n);
    await expect(svc.publishSigner({ username: "alice", agentLabel: "bot", address: "0x123" })).rejects.toThrow(/valid address/);
    expect(await svc.readSigner("bot.alice.nanitecom.eth")).toBe(AGENT);
  });
  it("agent creation writes agent-endpoint[mcp] = <API_PUBLIC_URL>/mcp; publishAgentEndpoint fixes old records and skips when current", async () => {
    const fake = createFakeChain();
    const records = new Map<string, string>();
    const reader = { getAddress: async () => AGENT, getText: async (n: string, k: string) => records.get(`${n}|${k}`) ?? null };
    const svc = createEnsService({ config, io: fake.io, reader, retryDelayMs: 0 });
    await svc.createUserName({ username: "alice", userWallet: USER });
    const a = await svc.createAgentName(agentArgs);
    expect(a.resolver).toBeTruthy();
    expect(agentEndpointUrl("https://api.example.test/")).toBe("https://api.example.test/mcp");
    expect(JSON.stringify(fake.sent, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toContain(stringToHex("https://api.example.test/mcp").slice(2)); // ABI-encoded inside the resolver initialize calls

    // An old placeholder record is rewritten once, then the script is a no-op.
    records.set("bot.alice.nanitecom.eth|agent-endpoint[mcp]", "http://localhost:4000/mcp");
    const r = await svc.publishAgentEndpoint({ username: "alice", agentLabel: "bot" });
    expect(Object.keys(r.txHashes)).toEqual(["set:agent-endpoint[mcp]"]);
    const last = fake.sent.at(-1)!;
    expect(last.fn).toBe("setText");
    expect(last.args[1]).toBe("agent-endpoint[mcp]");
    expect(last.args[2]).toBe("https://api.example.test/mcp");
    records.set("bot.alice.nanitecom.eth|agent-endpoint[mcp]", "https://api.example.test/mcp");
    const n = fake.sent.length;
    expect((await svc.publishAgentEndpoint({ username: "alice", agentLabel: "bot" })).skipped).toEqual(["set:agent-endpoint[mcp]"]);
    expect(fake.sent.length).toBe(n);
    expect(await svc.readAgentEndpoint("bot.alice.nanitecom.eth")).toBe("https://api.example.test/mcp");
  });
  it("revokeAgent revokes the setter role, optionally unregisters, and is idempotent", async () => {
    const { fake, svc } = setup();
    await svc.createUserName({ username: "alice", userWallet: USER });
    await svc.createAgentName(agentArgs);
    const r = await svc.revokeAgent({ username: "alice", agentLabel: "bot", unregister: true });
    expect(Object.keys(r.txHashes)).toEqual(["revoke:agent-context", "unregister"]);
    expect(r.unregistered).toBe(true);
    const rv = fake.sent.find((s) => s.fn === "revokeRoles")!;
    expect(rv.args[1]).toBe(RESOLVER_ROLE.SET_TEXT);
    expect(rv.args[2]).toBe(AGENT);
    expect(labelhash("agent-context")).toBe(rv.args[0]);
    const again = await svc.revokeAgent({ username: "alice", agentLabel: "bot", unregister: true });
    expect(again.txHashes).toEqual({});
    expect(again.skipped).toEqual(["revoke:agent-context", "unregister"]);
    expect(zeroAddress).toBeDefined();
    // a never-created agent still throws rather than silently succeeding
    await expect(svc.revokeAgent({ username: "alice", agentLabel: "ghost" })).rejects.toThrow(/no resolver/);
  });
});
