# ABI source

- Repo: https://github.com/ensdomains/contracts-v2
- Commit: 07e55a056f5b6a9c90119f501bdd05714e67dddd
- Fetched from: https://codeload.github.com/ensdomains/contracts-v2/tar.gz/07e55a056f5b6a9c90119f501bdd05714e67dddd (inside Docker)
- Artifacts: `contracts/deployments/sepolia/<Name>.json` (field `abi`), addresses from `contracts/deployments/sepolia/addresses.md` (deployed 2026-10-01)

| File here | Artifact | Solidity source |
| --- | --- | --- |
| ETHRegistry.json | deployments/sepolia/ETHRegistry.json | contracts/src/registry/PermissionedRegistry.sol |
| UserRegistryImpl.json | deployments/sepolia/UserRegistryImpl.json | contracts/src/registry/UserRegistry.sol |
| PermissionedResolverImpl.json | deployments/sepolia/PermissionedResolverImpl.json | contracts/src/resolver/PermissionedResolver.sol |
| VerifiableFactory.json | deployments/sepolia/VerifiableFactory.json | contracts/lib/verifiable-factory/src/VerifiableFactory.sol (from build-info) |
| UniversalResolverV2.json | deployments/sepolia/UniversalResolverV2.json | contracts/src/universalResolver/UniversalResolverV2.sol |

Role constants: see `config/roles.json`.
