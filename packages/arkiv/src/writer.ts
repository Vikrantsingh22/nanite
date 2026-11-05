// Write layer (server only: imports viem/accounts, so keep it out of browser bundles).
// Writer model: the operator creates each email entity and hands it to the user in the SAME
// executeBatch (create + changeOwnership). $creator stays the operator, $owner becomes the user.
// All writes of one writer account run through a FIFO queue with concurrency 1, because entity
// keys derive from the sender's nonce and concurrent batches would race it.
import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { addr, u64 } from '@arkiv-network/sdk/schema';
import { getAddress, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ArkivWriteError, EntityTooLargeError, InvalidEmailFieldsError } from './errors';
import { SerialQueue } from './queue';
import { type ArkivPublicClient, type WaitOptions, createArkivReader } from './reader';
import {
  EMAIL_TYPES,
  EmailSchema,
  KEY_ID_RE,
  MAX_PAYLOAD_BYTES,
  MAX_STR_BYTES,
  SENDER_HASH_RE,
  formatKeyIds,
  type EmailType,
} from './schema';

export { SerialQueue } from './queue';
export * from './errors';

export const DEFAULT_OTP_TTL_SECONDS = 300;

/** Plain-data expiry decision, convertible to an SDK `ExpirationTime`. */
export type ExpiryPlan = { kind: 'seconds'; seconds: number } | { kind: 'max' };

/**
 * Expiry policy: OTPs are short-lived (default 5 min), conversation and sent mail get the chain
 * maximum (7,884,000 blocks, about 182.5 days) and are extended later by a retention job.
 * `override`: seconds, or 'max'. Durations must be multiples of 2 s (block time), so we round up.
 */
export function expiryPlan(type: EmailType, opts: { otpTtlSeconds?: number; override?: number | 'max' } = {}): ExpiryPlan {
  const o = opts.override;
  if (o === 'max') return { kind: 'max' };
  if (o !== undefined) return secondsPlan(o);
  if (type === 'otp') return secondsPlan(opts.otpTtlSeconds ?? DEFAULT_OTP_TTL_SECONDS);
  return { kind: 'max' };
}
function secondsPlan(s: number): ExpiryPlan {
  if (!Number.isFinite(s) || s <= 0) throw new InvalidEmailFieldsError('expiry seconds must be positive');
  return { kind: 'seconds', seconds: Math.ceil(s / 2) * 2 };
}
function toExpiration(p: ExpiryPlan) {
  return p.kind === 'max' ? ExpirationTime.max() : ExpirationTime.fromSeconds(p.seconds);
}

export interface EmailFields {
  agentId: string;
  /** The Nanite user's wallet (indexed `ownerId`). */
  ownerId: Address;
  type: EmailType;
  /** Unix seconds. */
  receivedAt: number | bigint;
  threadId: string;
  /** 64 hex chars from @nanite/crypto `senderHash`. */
  senderHash: string;
  /** keyIds from `encryptEmail(...).keyIds`; stored sorted and comma-joined. */
  keyIds: readonly string[];
  ciphertext: Uint8Array;
  wrappedKeys: Uint8Array;
  nonce: Uint8Array;
}

export interface WriteEmailParams {
  fields: EmailFields;
  /** Final $owner of the entity (the user wallet). */
  owner: Address;
  /** Seconds, or 'max'. Default: policy by type (otp short, others max). */
  expiresIn?: number | 'max';
  /** Let anyone (incl. the operator) extend expiry. Default: true except for OTPs. Never allowed for OTPs. */
  permissionlessExtension?: boolean;
}

export interface WriteEmailResult {
  entityKey: Hex;
  txHash: Hex;
  attempts: number;
}

/** The minimal client surface the writer needs; tests inject fakes. */
export interface WriterBackend {
  predictEntityKeys(args: { owner: Address; count: number }): Promise<{ key: Hex; salt: bigint }[]>;
  executeBatch(args: unknown): Promise<{ txHash: Hex; createdEntities: Hex[] }>;
  extendEntity(args: { entityKey: Hex; expiration: unknown }): Promise<{ txHash: Hex }>;
}

export interface ArkivWriterConfig {
  privateKey: Hex;
  accessKey?: string;
  rpcUrl?: string;
  otpTtlSeconds?: number;
  /** Total tries for a batch that reverts (re-predicting the key each time). Default 3. */
  maxAttempts?: number;
  /** Inject fakes (tests). */
  backend?: WriterBackend;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const utf8Len = (s: string) => new TextEncoder().encode(s).length;

/** Validate fields and build the SDK value map. Throws EntityTooLargeError / InvalidEmailFieldsError. */
export function prepareValues(f: EmailFields): Record<string, unknown> {
  if (!(EMAIL_TYPES as readonly string[]).includes(f.type)) throw new InvalidEmailFieldsError(`unknown type: ${f.type}`);
  const size = f.ciphertext.length + f.wrappedKeys.length + f.nonce.length;
  if (size > MAX_PAYLOAD_BYTES) throw new EntityTooLargeError(size, MAX_PAYLOAD_BYTES);
  if (!f.agentId || utf8Len(f.agentId) > MAX_STR_BYTES) throw new InvalidEmailFieldsError('agentId empty or over 128 bytes');
  if (!f.threadId || utf8Len(f.threadId) > MAX_STR_BYTES) throw new InvalidEmailFieldsError('threadId empty or over 128 bytes');
  if (!SENDER_HASH_RE.test(f.senderHash)) throw new InvalidEmailFieldsError('senderHash must be 64 lower-case hex chars');
  if (f.keyIds.length === 0) throw new InvalidEmailFieldsError('keyIds must not be empty');
  for (const k of f.keyIds) if (!KEY_ID_RE.test(k.toLowerCase())) throw new InvalidEmailFieldsError('each keyId must be 16 hex chars');
  const keyIds = formatKeyIds(f.keyIds);
  if (utf8Len(keyIds) > MAX_STR_BYTES) throw new InvalidEmailFieldsError('too many keyIds for the 128-byte column (max 7)');
  const receivedAt = BigInt(f.receivedAt);
  if (receivedAt < 0n) throw new InvalidEmailFieldsError('receivedAt must be unix seconds >= 0');
  return {
    agentId: f.agentId,
    ownerId: addr(getAddress(f.ownerId)), // values must be wrapped: addr()/u64()
    type: f.type,
    receivedAt: u64(receivedAt),
    threadId: f.threadId,
    senderHash: f.senderHash,
    keyIds,
    ciphertext: f.ciphertext,
    wrappedKeys: f.wrappedKeys,
    nonce: f.nonce,
  };
}

/** Errors worth a re-predict + retry: on-chain reverts (nonce race / stale key), not input errors. */
function isRetryable(e: unknown): boolean {
  const err = e as Error;
  return err?.name === 'EntityMutationError' || /revert|nonce|already known|replacement/i.test(String(err?.message));
}
const safeMsg = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 300);

export function createArkivWriter(config: ArkivWriterConfig) {
  const account = privateKeyToAccount(config.privateKey);
  const address = account.address;
  const maxAttempts = config.maxAttempts ?? 3;
  const sleep = config.sleep ?? defaultSleep;
  const queue = new SerialQueue();

  const chain = rabdi({ accessKey: config.accessKey ?? '' });
  const transport = () => http(config.rpcUrl, { timeout: 30_000, retryCount: 1 });
  let backend = config.backend;
  let publicClient: ArkivPublicClient | undefined;
  if (!backend) {
    const pc = createPublicClient({ chain, transport: transport() });
    const wc = createWalletClient({ chain, transport: transport(), account });
    publicClient = pc as ArkivPublicClient;
    backend = {
      predictEntityKeys: (a) => pc.predictEntityKeys(a) as Promise<{ key: Hex; salt: bigint }[]>,
      executeBatch: (a) => (wc as any).executeBatch(a),
      extendEntity: (a) => (wc as any).extendEntity(a),
    };
  }
  const be = backend;
  // Reader pinned to this writer: used for waitForQueryable.
  const reader = createArkivReader({
    operatorAddress: address,
    ...(publicClient ? { client: publicClient } : {}),
    ...(config.accessKey !== undefined ? { accessKey: config.accessKey } : {}),
    ...(config.rpcUrl !== undefined ? { rpcUrl: config.rpcUrl } : {}),
  });

  async function writeEmail(p: WriteEmailParams): Promise<WriteEmailResult> {
    const values = prepareValues(p.fields); // size guard + validation happen BEFORE queueing
    const type = p.fields.type;
    if (type === 'otp' && p.permissionlessExtension === true) {
      throw new InvalidEmailFieldsError('OTPs must never be permissionlessExtension');
    }
    const permissionless = type === 'otp' ? false : (p.permissionlessExtension ?? true);
    const owner = getAddress(p.owner);
    const plan = expiryPlan(type, {
      ...(config.otpTtlSeconds !== undefined ? { otpTtlSeconds: config.otpTtlSeconds } : {}),
      ...(p.expiresIn !== undefined ? { override: p.expiresIn } : {}),
    });

    return queue.run(async () => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Predict immediately before sending: the key depends on the sender's current nonce.
        const [pred] = await be.predictEntityKeys({ owner: address, count: 1 });
        if (!pred) throw new ArkivWriteError('predictEntityKeys returned nothing', attempt);
        try {
          const r = await be.executeBatch({
            creates: [
              {
                schema: EmailSchema,
                values,
                expiration: toExpiration(plan),
                salt: pred.salt,
                ...(permissionless ? { flags: { permissionlessExtension: true } } : {}),
              },
            ],
            // Transfer to self reverts (TransferToSelf), so skip it when the owner is the operator.
            ...(owner.toLowerCase() !== address.toLowerCase()
              ? { ownershipChanges: [{ entityKey: pred.key, newOwner: owner }] }
              : {}),
          });
          const entityKey = r.createdEntities[0];
          if (!entityKey) throw new ArkivWriteError('batch created no entity', attempt);
          return { entityKey, txHash: r.txHash, attempts: attempt };
        } catch (e) {
          lastErr = e;
          if (e instanceof ArkivWriteError || !isRetryable(e) || attempt === maxAttempts) {
            throw new ArkivWriteError(`write failed after ${attempt} attempt(s): ${safeMsg(e)}`, attempt);
          }
          await sleep(500 * attempt);
        }
      }
      throw new ArkivWriteError(`write failed: ${safeMsg(lastErr)}`, maxAttempts);
    });
  }

  /**
   * Extend an entity to the chain maximum (or `expiresIn` seconds from now). Works for the operator
   * only on entities created with permissionlessExtension (conversation/sent); OTPs revert.
   */
  function extendEmail(entityKey: Hex, o: { expiresIn?: number | 'max' } = {}): Promise<{ txHash: Hex }> {
    const expiration = toExpiration(o.expiresIn === undefined || o.expiresIn === 'max' ? { kind: 'max' } : secondsPlan(o.expiresIn));
    return queue.run(async () => {
      try {
        const r = await be.extendEntity({ entityKey, expiration });
        return { txHash: r.txHash };
      } catch (e) {
        throw new ArkivWriteError(`extend failed: ${safeMsg(e)}`, 1);
      }
    });
  }

  return {
    address,
    writeEmail,
    extendEmail,
    waitForQueryable: (key: Hex, o?: WaitOptions) => reader.waitForQueryable(key, o),
    reader,
    queue,
  };
}

export type ArkivWriter = ReturnType<typeof createArkivWriter>;
