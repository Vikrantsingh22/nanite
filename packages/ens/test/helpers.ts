// A tiny in-memory fake of the contracts the service touches, behind the ChainIO interface.
import { decodeFunctionData, getAddress, keccak256, toHex, zeroAddress, type Address, type Hex } from "viem";
import { abis } from "../src/abis.js";
import type { CallSpec, ChainIO, SentTx } from "../src/chain.js";
import type { EnsConfig } from "../src/config.js";
import { labelhash, STATUS, type NameReader, type RegistryState } from "../src/service.js";

export const OPERATOR = getAddress("0x38CbFe210ce51A97fE698982952412AB12ad3dab");
export const USER = getAddress("0xfAD31e74F1Cb69046BBB2e4A15ce653beE6936C0");
export const AGENT = getAddress("0xC0575045B1acacC1349e3e5f8bE20FBA3a8E287b");
export const NOW = 1_800_000_000n;
export const PARENT_EXPIRY = NOW + 100n * 86400n; // short, so clamping is visible
export const PUBKEY = "ab".repeat(32);

export const config: EnsConfig = {
  chainId: 11155111,
  rpcUrl: "http://fake",
  operatorPrivateKey: `0x${"11".repeat(32)}`,
  parentLabel: "nanitecom",
  contracts: {
    ethRegistry: getAddress("0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4"),
    factory: getAddress("0xda70306c98e97ece36f997a21368e53298572991"),
    userRegistryImpl: getAddress("0x9bd8a88719068d09ecee662f36c0e3856708366a"),
    resolverImpl: getAddress("0x115eb53f0c60696633855f90b138178fb40b2b2c"),
    universalResolver: getAddress("0x24e1d8e068620b647ca097f961a61055f4f42d72"),
    parentRegistry: getAddress("0xD2BE04253E815972D6a1D995670eBAc7a6C8C786"),
  },
  apiPublicUrl: "https://api.example.test",
};

export interface SentRecord {
  fn: string;
  address: Address;
  args: readonly unknown[];
}

export function createFakeChain() {
  const code = new Set<Address>();
  const states = new Map<string, RegistryState>(); // `${registry}:${labelhash}`
  const subregistry = new Map<string, Address>(); // `${registry}:${label}`
  const resolvers = new Map<string, Address>();
  const parents = new Map<Address, readonly [Address, string]>();
  const textRoles = new Set<string>(); // `${resolver}:${resource}:${account}`
  const rootRoles = new Map<string, bigint>(); // `${proxy}:${account}` -> root role bitmap from initialize()
  const sent: SentRecord[] = [];
  const saltToAddr = new Map<bigint, Address>();
  let tokenCounter = 1000n;
  let deniedHasRootRoles = false;

  // ETHRegistry parent name state
  states.set(`${config.contracts.ethRegistry}:${labelhash("nanitecom")}`, {
    status: STATUS.REGISTERED,
    expiry: PARENT_EXPIRY,
    latestOwner: getAddress("0x8fFD876f6200BCF671714E35b860aDFD57a6a542"),
    tokenId: 1n,
    resource: 1n,
  });

  const addrFor = (salt: bigint): Address => {
    const a = getAddress(`0x${keccak256(toHex(salt)).slice(26)}`);
    saltToAddr.set(salt, a);
    return a;
  };

  const io: ChainIO = {
    operator: OPERATOR,
    now: async () => NOW,
    hasCode: async (a) => code.has(getAddress(a)),
    waitForCode: async () => undefined,
    read: async (call: CallSpec) => {
      const a = getAddress(call.address);
      const args = call.args as unknown[];
      switch (call.functionName) {
        case "predictProxyAddress":
          return addrFor(args[1] as bigint);
        case "getState":
          return states.get(`${a}:${args[0] as bigint}`) ?? { status: STATUS.AVAILABLE, expiry: 0n, latestOwner: zeroAddress, tokenId: 0n, resource: 0n };
        case "getSubregistry":
          return subregistry.get(`${a}:${args[0] as string}`) ?? zeroAddress;
        case "getResolver":
          return resolvers.get(`${a}:${args[0] as string}`) ?? zeroAddress;
        case "getParent":
          return parents.get(a) ?? [zeroAddress, ""];
        case "hasRootRoles": {
          if (deniedHasRootRoles) return false;
          const have = rootRoles.get(`${a}:${getAddress(args[1] as Address)}`);
          if (have === undefined) return ![...rootRoles.keys()].some((k) => k.startsWith(`${a}:`)); // unknown proxy: permissive
          return (have & (args[0] as bigint)) === (args[0] as bigint);
        }
        case "hasRoles":
          return textRoles.has(`${a}:${args[0] as bigint}:${getAddress(args[2] as Address)}`);
        default:
          throw new Error(`fake chain: unhandled read ${call.functionName}`);
      }
    },
    send: async (call: CallSpec): Promise<SentTx> => {
      const a = getAddress(call.address);
      const args = call.args as unknown[];
      sent.push({ fn: call.functionName, address: a, args });
      let result: unknown;
      switch (call.functionName) {
        case "deployProxy": {
          const proxy = addrFor(args[1] as bigint);
          code.add(proxy);
          for (const abi of [abis.resolver, abis.userRegistry]) {
            try {
              const dec = decodeFunctionData({ abi, data: args[2] as Hex });
              if (dec.functionName !== "initialize") continue;
              for (const g of (dec.args as unknown[])[0] as { account: Address; roleBitmap: bigint }[]) {
                rootRoles.set(`${proxy}:${getAddress(g.account)}`, g.roleBitmap);
              }
              break;
            } catch {
              /* not this ABI */
            }
          }
          break;
        }
        case "setParent":
          parents.set(a, [getAddress(args[0] as Address), args[1] as string]);
          break;
        case "register": {
          const [label, owner, registry, resolver, , expiry] = args as [string, Address, Address, Address, bigint, bigint];
          const tokenId = (tokenCounter += 1n);
          states.set(`${a}:${labelhash(label)}`, { status: STATUS.REGISTERED, expiry, latestOwner: getAddress(owner), tokenId, resource: tokenId });
          subregistry.set(`${a}:${label}`, registry);
          resolvers.set(`${a}:${label}`, resolver);
          result = tokenId;
          break;
        }
        case "unregister": {
          for (const [k, v] of states) if (k === `${a}:${args[0] as bigint}`) states.set(k, { ...v, status: STATUS.AVAILABLE });
          // The real registry forgets the resolver of an unregistered name.
          for (const k of [...resolvers.keys()]) {
            if (k.startsWith(`${a}:`) && labelhash(k.slice(a.length + 1)) === (args[0] as bigint)) resolvers.delete(k);
          }
          break;
        }
        case "grantSetterRoles": {
          const dec = decodeFunctionData({ abi: abis.resolver, data: args[0] as Hex });
          if (dec.functionName !== "setText") throw new Error("expected a setText setter");
          const key = (dec.args as unknown[])[1] as string;
          textRoles.add(`${a}:${labelhash(key)}:${getAddress(args[1] as Address)}`);
          break;
        }
        case "revokeRoles":
          textRoles.delete(`${a}:${args[0] as bigint}:${getAddress(args[2] as Address)}`);
          break;
        default:
          break;
      }
      return { hash: toHex(sent.length, { size: 32 }), gasUsed: 100_000n, result };
    },
  };

  return {
    io,
    sent,
    code,
    states,
    deny: () => {
      deniedHasRootRoles = true;
    },
    grantNothing: () => textRoles.clear(),
  };
}

export const emptyReader: NameReader = {
  getAddress: async () => AGENT,
  getText: async () => null,
};
