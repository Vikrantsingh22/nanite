# ABI check (contracts-v2 @ 07e55a056f5b6a9c90119f501bdd05714e67dddd, Sepolia artifacts)

Addresses in `config/sepolia.json` match `contracts/deployments/sepolia/addresses.md` for all 8 contracts, and all have code on Sepolia (checked read-only with `scripts/ens/check-addresses.ts`).

| Item | Expected (status file) | Actual | Match |
| --- | --- | --- | --- |
| `VerifiableFactory.deployProxy` | `(address implementation, uint256 salt, bytes data) returns (address)` | same. Also `predictProxyAddress(address deployer, uint256 salt)`, `proxyLogic()`, `verifyContract(address)`. CREATE2 salt = `keccak256(abi.encode(msg.sender, salt))`; EIP-1167 clone + appended salt | yes |
| `UserRegistry.initialize` | `initialize(Grant[] grants)`, `Grant = {account, roleBitmap}` | `initialize((address account,uint256 roleBitmap)[])`; reverts `InvalidOwner` if no root roles | yes |
| `PermissionedResolver.initialize` | `initialize(Grant[] grants, bytes[] calls)` | `initialize((address,uint256)[],bytes[])` | yes |
| `register` | `register(label, owner, registry, resolver, roleBitmap, expiry)` | `register(string label,address owner,address registry,address resolver,uint256 roleBitmap,uint64 expiry) returns (uint256 tokenId)`; needs `ROLE_REGISTRAR` on ROOT (`_checkRoles(ROOT_RESOURCE, ROLE_REGISTRAR, msg.sender)`), so the operator CAN call it directly. If `owner==0` then `roleBitmap` must be 0 (reserve). Root-only roles on the new name are granted via `roleBitmap` | yes |
| `setSubregistry` | `(anyId, registry)` | `setSubregistry(uint256 anyId, address registry)`; needs `ROLE_SET_SUBREGISTRY` on the name's resource (root OR token); name must not be expired | yes |
| `setParent` (UserRegistry) | not specified | `setParent(address parent, string label)`, `onlyRootRoles(ROLE_SET_PARENT)` (in ALL_ROLES). Label is the child label (`"nanitecom"`), parent is the ETHRegistry | n/a |
| `grantRootRoles` | `(roleBitmap, account)` | `grantRootRoles(uint256 roleBitmap, address account) returns (bool)` | yes |
| `grantSetterRoles` | `grantSetterRoles(setter calldata, account)` | `grantSetterRoles(bytes setter, address account) returns (bool)`. `setter` is the full ABI-encoded calldata of a setter, e.g. `setText(bytes name, string key, string value)`; only the key / coinType is decoded. Caller needs the matching admin role on that resource (`_checkCanGrantRoles`). Supported selectors: setAddress, setText, setData, setABI, setInterface | yes, but the setter encoding is notable |
| `setText` / `setAddr` | `setText(key,value)`, `setAddr` | DIFFERENT: `setText(bytes name, string key, string value)` and `setAddress(bytes name, uint256 coinType, bytes addressBytes)`. `name` is the DNS-encoded name. The function is `setAddress`, not `setAddr`. `setContenthash`, `setName`, `linkToNode`, `linkToRecord` are root-role-only | NO (extra leading `bytes name` arg; name `setAddress`) |
| `getState` | `getState(anyId)` | `getState(uint256 anyId) returns (State{uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource})`; Status: 0 AVAILABLE, 1 RESERVED, 2 REGISTERED | yes |
| `hasRoles` | `hasRoles(...)` | `hasRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)`; also `hasRootRoles(uint256,address)`, `roles(uint256 anyId,address)` (on registries `anyId` is accepted) | yes |
| `grantRoles` (registry) | `grantRoles(anyId, roleBitmap, account)` | `grantRoles(uint256 anyId,uint256 roleBitmap,address account)`; the resolver's `grantRoles` always reverts, use `grantSetterRoles` | yes |
| ROLE values | `ROLE_SET_TEXT = 1<<4`, `ROLE_SET_ADDRESS = 1<<0` | confirmed, see `config/roles.json` | yes |
| `ALL_ROLES` | `0x1111...1111` | confirmed (64 nybbles) | yes |

## anyId format for setSubregistry on `nanitecom`

`anyId` can be labelhash, tokenId or resource; the low 32 bits are version bits and are zeroed internally. We use the labelhash `uint256(keccak256("nanitecom"))`.

## Sepolia state of nanitecom (read-only, ETHRegistry.getState)

- status 2 (REGISTERED), expiry 1825432500, latestOwner = owner 0x8fFD...a542
- tokenId = resource = `0xe2fa25956ff55d6213aeaa4434c3eff0cbc108d6bf63e3ffdb78594a00000000` (labelhash with version 0 in the low 32 bits)
- owner roles on the name: `0x1110000000000000000000000000000001100000` = ROLE_SET_SUBREGISTRY + ROLE_SET_RESOLVER (+ admin roles) and ROLE_CAN_TRANSFER_ADMIN. So the owner holds ROLE_SET_SUBREGISTRY on the name (the open item is closed: yes).

## Other findings

- The status file's "operator cannot call register directly" worry: it can, if it holds `ROLE_REGISTRAR` on the registry root.
- `ETHRegistry` (PermissionedRegistry) setSubregistry does not validate the target is a contract, so it can be set before the proxy exists. Simulation passes before deploy; do deploy first anyway.
- `ROLE_SET_PARENT` exists (nybble 2) and is part of the ALL_ROLES the owner grants itself.
