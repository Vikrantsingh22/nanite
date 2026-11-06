# @arkiv-network/sdk 1.0.1 notes (W0)

Source read: `node_modules/@arkiv-network/sdk/src/**` (the package ships `src` next to `dist`). Paths below are relative to `node_modules/@arkiv-network/sdk/src/`. Docs index: https://docs.arkiv.network/llms.txt. Peer dep `viem ^2.0.0` (our pin 2.21.54 works and typechecks).

## Clients
- `createPublicClient({chain, transport})`: read actions only (`getEntity`, `select`, `query`, `count`, `getEntityNonce`, `predictEntityKeys`, `getBlockTiming`, `watchEntityEvents` + viem public actions). `clients/decorators/arkivPublic.ts`.
- `createWalletClient({chain, transport, account})`: write actions + viem public/wallet actions but NOT the Arkiv read actions. `clients/decorators/arkivWallet.ts`, `clients/createWalletClient.ts`. Read with a separate public client.
- `rabdi({accessKey})` (`chains/rabdi.ts`): `accessKey` is REQUIRED (throws `MissingAccessKeyError`); `""` = public rate-limited endpoint (and one console.warn). Key becomes the last URL path segment. chainId 7794095, tGLM, explorer https://rabdi.explorer.arkiv.network. Free keys: https://hub.arkiv.network/access-keys.
- Registry/engine address `ARKIV_ADDRESS = 0x4400…0044`, `BLOCK_TIME = 2`, `MAX_LIFETIME = 7_884_000n` blocks, `GAS_HEADROOM_PERCENT = 25n`, `MAX_TRANSACTION_GAS = 2^24` (`consts.ts`).

## Write signatures (wallet client)
All take optional last arg `txParams?: TxParams` (`types/txParams.ts`, viem tx overrides, e.g. `gas`). All wait for the receipt; revert -> `EntityMutationError` with decoded reason.
- `createEntity(schema, values, { expiration, flags?, salt? }) -> { entityKey: Hex, txHash, expiresAt: bigint /*block*/ }` (`actions/wallet/createEntity.ts`)
- `patchEntity(schema, entityKey, { set?, unset? }) -> { entityKey, txHash }`. Only named columns change; empty patch -> `EmptyPatchError`. Key, owner, flags, expiry never change. (`patchEntity.ts`)
- `extendEntity({ entityKey, expiration }) -> { entityKey, txHash, expiresAt }`. SETS a new expiry (duration counts from now, not added to current); earlier than current reverts `ExpiryNotExtended`. (`extendEntity.ts`)
- `changeOwnership({ entityKey, newOwner }) -> { entityKey, txHash }` (`changeOwnership.ts`). Reverts `TransferToSelf`, `TransferToZeroAddress`, `NotOwner`.
- `deleteEntity({ entityKey }) -> { entityKey, txHash }` (`deleteEntity.ts`)
- `executeBatch({ creates?, patches?, deletes?, extensions?, ownershipChanges? }) -> { txHash, createdEntities: Hex[], patchedEntities, deletedEntities, extendedEntities, ownershipChanges }` (`executeBatch.ts`).

## Batching: create + changeOwnership in ONE tx — YES
`executeBatch` sends one `execute((uint8,bytes)[])` tx; the engine applies ops atomically and in order, op n+1 sees op n's effects (`entity/operations.ts` doc comment). The SDK orders ops as: creates, patches, deletes, extensions, ownershipChanges (`utils/arkivTransactions.ts` ~L130), so a create followed by a transfer of the just-created key works. The new key must be known up front: `predictEntityKeys({owner, count})` returns `{key, salt}[]`; pass that `salt` in the create so the key matches (the default salt is random). Pitfall: prediction holds only if no other create from that owner is in flight (nonce race). Raw ABI tags: Create=1, Patch=2, ExtendExpiry=3, TransferOwnership=4, Delete=5 (`entity/params.ts`). Not yet verified on-chain (RPC unreachable during W0).

## Owner / on-behalf param: NONE
`CreateEntityOptions` = `{expiration, flags?, salt?}` only. The creator (tx sender) is the initial `$owner`; there is no `owner` argument. To have the user own an entity written by an operator: create then `changeOwnership` (can be one batch, see above). `$creator` (immutable, queryable via `.createdBy()`) stays the operator; `$owner` becomes the user. No delegation/permit mechanism in the SDK. After transfer, the new owner alone can patch/extend/delete (`NotOwner` otherwise), unless `permissionlessExtension` is set (anyone may extend). The operator loses write access to the entity after transfer.

## Flags (`entity/flags.ts`)
Creation-time only, immutable. Bit 0 (0x01) `readonly`: attributes can never change (extend, transfer, delete still allowed). Bit 1 (0x02) `permissionlessExtension`: anyone may extend expiry. Bits 2-7 reserved (`ReservedCreationFlags`). Read back via `$creationFlags` (`{readonly, permissionlessExtension, raw}`).

## Key derivation (`entity/key.ts`)
`key = keccak256(encodePacked(uint256 chainId, address ARKIV_ADDRESS, address creator, uint64 nonce, uint128 salt))`. `creator` = tx sender, NOT the later owner. `nonce` = per-creator counter (`entityNonce(address)` view on the engine; `getEntityNonce`); each create in a batch uses nonce+n. Salt defaults to 128 random bits (key unpredictable to others); `NO_SALT` (=0) makes the key computable by anyone from creator+nonce. `randomSalt()`, `predictEntityKey()` exported.

## Expiry (`entity/expiry.ts`, `utils/expirationTime.ts`)
Wire pair `{expiresAt (absolute block), minLifetime (blocks)}`; engine resolves `max(expiresAt, currentBlock + minLifetime)`. `ExpirationTime.fromSeconds/Minutes/Hours/Days/Weeks/Months(30d)/Years(365d)/fromBlocks/max()` set minLifetime; `atBlock(n, {atLeast})`, `atDate(d, {atLeast})` set expiresAt (`atLeast` = a minLifetime floor, i.e. "at the deadline, but at least N from now"). Durations must be multiples of 2 s. Max 7,884,000 blocks from landing block; SDK pre-checks (`InvalidExpiryError`), chain reverts `ExpiryBeyondMaxLifetime`/`ExpiryDeadOnArrival`. Expiry is block-based: wall-clock drifts with block time (observable via `arkiv_getBlockTiming`). No unbounded lifetime: long-lived mail needs periodic `extendEntity`.

## Schema / values (`schema/*`)
`defineSchema(name?, columns)`; named schema adds an `arkiv.schema` tag attribute (so max 31 columns; max 32 attributes/entity). Types `bool,i32,u64,u256,dec,str,addr,key,bytes`. `.indexed()` (not on bytes), `.optional()`, `.default(v)`. `str` <= 128 UTF-8 bytes; each `bytes` <= 128 KiB AND all bytes of one create/patch share `MAX_ENTITY_BYTES = 128 KiB` (`EntityTooLargeError`). Values must be wrapped: `u64(1n)`, `addr(...)` (EIP-55 checked), `dec("4.5")`, `key(...)`; bare JS forms accepted in create values. Attribute name <= 32 bytes.

## Query builder (`query/*`, `clients/decorators/arkivPublic.ts`)
- `client.select(selection?)`: `"*"`/omit = all; or `{ $key: true, $owner, $creator, $createdAt, $updatedAt, $expiresAt, $creationFlags, $attributes: true, $attributeSchema: true, <attrName>: true }`. Flat rows. Selecting `bytes` columns of many rows can exceed response size.
- `.from(schema, {onMismatch: "skip"|"throw"})`: types rows, restricts `where` to indexed columns, and for a NAMED schema adds the tag filter. Mismatching entities are skipped by default (`result.skipped`). Arkiv is public: anyone can write look-alike entities, so also filter `.ownedBy()`/`.createdBy()`.
- `.where(expr, ...)` multiple args ANDed; `.ownedBy(addr)` = `$owner = addr(..)`, `.createdBy(addr)` = `$creator`. At least one filter is required (else `InvalidPredicateError`). Expressions from `@arkiv-network/sdk/query`: `eq, gt, gte, lt, lte, between, startsWith, exists, hasType, and, or` (NO `ne`/`not` exported in 1.0.1 even though docs list them). Queryable system attrs: `$key,$owner,$creator,$expiresAt` (`$createdAt/$updatedAt/$creationFlags` are result-only). Rendered syntax: `agentId = str('x') AND receivedAt >= u64(5)`, `$expiresAt > u64(0)`.
- `.orderBy(asc|desc(col[, type]))` ONE key only; any non-bytes column, indexed or not (`query/order.ts`).
- `.limit(n)` 1..100 (`MAX_LIMIT`), `.offset(n)`, `.withCount()` -> `page.count: bigint`. NO cursor/`next()`/`atBlock` in 1.0.1 (docs mention them; grep of src finds none). Page by `orderBy(asc("$key"))` + `where(gt("$key", key(last)))`. `fetch()` -> `QueryResult { entities, blockNumber, skipped, count }`.
- `client.count().from(s).where(..).fetch() -> bigint`.
- `client.query(expr | rawString, { select, orderBy, limit, offset, count })` for schema-less; raw strings are unchecked. Without a schema: values come back as `{type, value}` under `$attributes` (`ArkivValue`); sorting needs the type: `desc("score","dec")`.
- `client.getEntity(key[, schema])` throws `NoEntityFoundError` if missing/expired/deleted.
- Raw RPC: `arkiv_query(query, {select:{key,owner,creator,createdAt,updatedAt,expiresAt,creationFlags,attributeSchema,attributes,count}, limit:hex, offset:hex}) -> {data, blockNumber, count?}`; `arkiv_getEntity([key])`; `arkiv_getBlockTiming() -> {current_block, current_block_time, duration}` (`types/rpcSchema.ts`).

## Watch events (`actions/public/watchEntityEvents.ts`)
`client.watchEntityEvents({ onEntityCreated, onEntityPatched, onExpiryExtended, onOwnershipTransferred, onEntityDeleted, onEvent, onError, pollingInterval=1000ms }) -> unwatch()`. Polls a log filter on the engine address; events carry block, txHash, logIndex. No history: only events after the first poll. Event fields in `types/events.ts` (created: entityKey, owner, expiresAt, creationFlags; transferred: previousOwner, newOwner; ...). Expiry produces no event (entities just stop appearing).

## Errors exported (`errors.ts`, `entity/errors.ts`, `schema/errors.ts`, `query/errors.ts`)
`EntityMutationError{txHash}`, `NoEntityFoundError`, `EmptyPatchError`, `MissingAccessKeyError`, `InvalidExpiryError`, `InvalidCreationFlagsError`, `InvalidSaltError`, `NoRandomSourceError`, schema: `SchemaDefinitionError, SchemaMismatchError, InvalidValueError, MissingValueError, UntypedValueError, TooManyAttributesError, EntityTooLargeError, ConflictingMutationError, InvalidAttributeNameError, UnknownAttributeTypeError`; query: `QueryError{kind: parse|type|literal|limits, code}`, `InvalidPredicateError`, `UnsupportedOperatorError`. On-chain reverts decoded in `utils/arkivTransactions.ts` (`NotOwner`, `ReadOnlyEntity`, `EntityExpired`, `EntityNotFound`, `ExpiryNotExtended`, `ExpiryBeyondMaxLifetime`, `TooManyAttributes`, ...).

## Gas
Estimated via `estimateContractGas` + 25% headroom, capped at 2^24. Tx that runs out of gas still consumes fee (`EntityMutationError` says so).
