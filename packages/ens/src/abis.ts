import type { Abi } from "viem";
import userRegistry from "../../../contracts/abi/UserRegistryImpl.json" with { type: "json" };
import ethRegistry from "../../../contracts/abi/ETHRegistry.json" with { type: "json" };
import resolver from "../../../contracts/abi/PermissionedResolverImpl.json" with { type: "json" };
import factory from "../../../contracts/abi/VerifiableFactory.json" with { type: "json" };
import universalResolver from "../../../contracts/abi/UniversalResolverV2.json" with { type: "json" };

export const abis = {
  userRegistry: userRegistry as unknown as Abi,
  ethRegistry: ethRegistry as unknown as Abi,
  resolver: resolver as unknown as Abi,
  factory: factory as unknown as Abi,
  universalResolver: universalResolver as unknown as Abi,
} as const;
