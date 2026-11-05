// Read layer. Works in Node and the browser (no viem/accounts, no node:* imports).
// SECURITY: every query is pinned to `$creator = <operator>`. Arkiv is public and anyone can write
// look-alike entities with our schema; `$owner` alone is not enough (an attacker can transfer a
// fake entity to a victim). The operator address is therefore mandatory config.
import { createPublicClient, NoEntityFoundError } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { desc, eq, gt, lt, or } from '@arkiv-network/sdk/query';
import { addr, key as keyValue, u64 } from '@arkiv-network/sdk/schema';
import { getAddress, hexToBytes, http, isAddress, type Address, type Hex } from 'viem';
import { InvalidEmailFieldsError, QueryTimeoutError, UntrustedEntityError } from './errors';
import { EMAIL_TYPES, EmailSchema, parseKeyIds, type EmailType } from './schema';

export const RABDI_CHAIN_ID = 7794095;
export const RABDI_EXPLORER = 'https://rabdi.explorer.arkiv.network';
export const RABDI_RPC_URL = 'https://rpc.rabdi.db-chain.testnet.arkiv.network';
export const MAX_PAGE = 100;

function makeClient(accessKey: string, rpcUrl?: string) {
  return createPublicClient({
    chain: rabdi({ accessKey }),
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }),
  });
}
export type ArkivPublicClient = ReturnType<typeof makeClient>;

export interface ArkivReaderConfig {
  /** The Nanite operator address that created every legitimate entity ($creator pin). */
  operatorAddress: Address;
  /** Rate-limit key only (not a signing key). Empty = public, throttled endpoint. */
  accessKey?: string;
  /** Override the RPC URL (default: derived from the chain + access key). */
  rpcUrl?: string;
  /** Inject a ready client (tests). */
  client?: ArkivPublicClient;
}

/** A decoded, trusted email entity. Pass it straight to `decryptEmail` from @nanite/crypto. */
export interface EmailRecord {
  $key: Hex;
  $owner: Address;
  $creator: Address;
  /** Expiry as a BLOCK NUMBER (2 s blocks). There is no expiry event; derive countdowns from it. */
  $expiresAt: bigint;
  agentId: string;
  ownerId: Address;
  type: EmailType;
  /** Unix seconds. */
  receivedAt: number;
  threadId: string;
  senderHash: string;
  keyIds: string[];
  ciphertext: Uint8Array;
  wrappedKeys: Uint8Array;
  nonce: Uint8Array;
}

export interface InboxFilter {
  agentId: string;
  /** Match the indexed `ownerId` attribute (the Nanite user wallet). */
  ownerId?: Address;
  /** Match the indexed `senderHash` attribute (per-user HMAC of the sender/counterparty address). */
  senderHash?: string;
  /** Additionally pin `$owner` (current entity owner). */
  owner?: Address;
  types?: readonly EmailType[];
  /** receivedAt < before (unix seconds, exclusive). */
  before?: number;
  /** receivedAt > after (unix seconds, exclusive). */
  after?: number;
}

export interface ListInboxOptions extends InboxFilter {
  /** 1..100, default 25. */
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** false = leave out the byte columns (they come back empty): cheap listing. Default true. */
  includeBytes?: boolean;
}

export interface InboxPage {
  items: EmailRecord[];
  /** Present when more rows may exist. */
  nextCursor?: string;
  /** Entities that matched but did not fit the schema and were skipped. */
  skipped: number;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// --- cursor: opaque offset. Offset paging can shift while new mail arrives; for a stable walk use
// `before` (receivedAt of the last row) instead. The SDK has no native cursor in 1.0.1. ---
export function encodeCursor(offset: number): string {
  return `o${offset.toString(36)}`;
}
export function decodeCursor(cursor: string): number {
  const m = /^o([0-9a-z]{1,10})$/.exec(cursor);
  const n = m ? parseInt(m[1]!, 36) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new InvalidEmailFieldsError('invalid cursor');
  return n;
}

function checkTypes(types: readonly string[]): void {
  for (const t of types) {
    if (!(EMAIL_TYPES as readonly string[]).includes(t)) throw new InvalidEmailFieldsError(`unknown email type: ${t}`);
  }
}

function toUnixSeconds(v: number, name: string): bigint {
  if (!Number.isSafeInteger(v) || v < 0) throw new InvalidEmailFieldsError(`${name} must be a non-negative integer`);
  return BigInt(v);
}

const toBytes = (v: unknown): Uint8Array =>
  v instanceof Uint8Array ? v : typeof v === 'string' ? hexToBytes(v as Hex) : new Uint8Array(0);

/** Schema columns come back as `{ type, value }` ArkivValues; plain values pass through. */
const unwrap = (v: unknown): unknown =>
  v !== null && typeof v === 'object' && !(v instanceof Uint8Array) && 'value' in v ? (v as { value: unknown }).value : v;

/** Map a raw SDK row to a record, re-checking the creator pin (defence in depth). */
export function rowToRecord(raw: Record<string, unknown>, operator: Address): EmailRecord {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) row[k] = k.startsWith('$') ? v : unwrap(v);
  const key = String(row.$key);
  const creator = String(row.$creator ?? '');
  if (!same(creator, operator)) throw new UntrustedEntityError(key, 'creator');
  const type = String(row.type);
  if (!(EMAIL_TYPES as readonly string[]).includes(type)) throw new UntrustedEntityError(key, 'schema');
  return {
    $key: key as Hex,
    $owner: String(row.$owner) as Address,
    $creator: creator as Address,
    $expiresAt: BigInt(row.$expiresAt as bigint | string | number),
    agentId: String(row.agentId),
    ownerId: String(row.ownerId) as Address,
    type: type as EmailType,
    receivedAt: Number(row.receivedAt as bigint | string | number),
    threadId: String(row.threadId),
    senderHash: String(row.senderHash),
    keyIds: parseKeyIds(String(row.keyIds)),
    ciphertext: toBytes(row.ciphertext),
    wrappedKeys: toBytes(row.wrappedKeys),
    nonce: toBytes(row.nonce),
  };
}

const META = ['agentId', 'ownerId', 'type', 'receivedAt', 'threadId', 'senderHash', 'keyIds'] as const;
const BYTES = ['ciphertext', 'wrappedKeys', 'nonce'] as const;
function selection(includeBytes: boolean) {
  const sel: Record<string, true> = { $key: true, $owner: true, $creator: true, $expiresAt: true };
  for (const c of META) sel[c] = true;
  if (includeBytes) for (const c of BYTES) sel[c] = true;
  return sel;
}

export function createArkivReader(config: ArkivReaderConfig) {
  if (!isAddress(config.operatorAddress)) throw new InvalidEmailFieldsError('operatorAddress is required (the $creator pin)');
  const operator = getAddress(config.operatorAddress);
  const client = config.client ?? makeClient(config.accessKey ?? '', config.rpcUrl);

  // The SDK builder types are deeply generic; this one cast contains them.
  const sdk = client as any;

  /** Apply the shared filters (creator pin, owner, where-clauses) to a select/count builder. */
  function applyFilters(builder: any, f: InboxFilter): any {
    if (!f.agentId) throw new InvalidEmailFieldsError('agentId is required');
    let b = builder.createdBy(operator);
    if (f.owner) b = b.ownedBy(getAddress(f.owner));
    const where: unknown[] = [eq('agentId', f.agentId)];
    if (f.ownerId) where.push(eq('ownerId', addr(getAddress(f.ownerId))));
    if (f.senderHash) where.push(eq('senderHash', f.senderHash));
    if (f.types?.length) {
      checkTypes(f.types);
      const terms = f.types.map((t) => eq('type', t));
      where.push(terms.length === 1 ? terms[0] : (or as any)(...terms));
    }
    if (f.before !== undefined) where.push(lt('receivedAt', u64(toUnixSeconds(f.before, 'before'))));
    if (f.after !== undefined) where.push(gt('receivedAt', u64(toUnixSeconds(f.after, 'after'))));
    return b.where(...where);
  }

  function inboxBuilder(f: InboxFilter, includeBytes: boolean) {
    return applyFilters(sdk.select(selection(includeBytes)).from(EmailSchema), f).orderBy(desc('receivedAt'));
  }

  /** The exact query string a listInbox call sends (for docs and tests). */
  function buildInboxQuery(f: InboxFilter): string {
    return inboxBuilder(f, false).toString();
  }

  async function listInbox(opts: ListInboxOptions): Promise<InboxPage> {
    const limit = opts.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      throw new InvalidEmailFieldsError(`limit must be an integer 1..${MAX_PAGE}`);
    }
    const offset = opts.cursor ? decodeCursor(opts.cursor) : 0;
    let b = inboxBuilder(opts, opts.includeBytes ?? true).limit(limit);
    if (offset > 0) b = b.offset(offset);
    const page = await b.fetch();
    const items = (page.entities as Record<string, unknown>[]).map((r) => rowToRecord(r, operator));
    const covered = items.length + (page.skipped as number);
    return {
      items,
      skipped: page.skipped as number,
      ...(covered >= limit ? { nextCursor: encodeCursor(offset + covered) } : {}),
    };
  }

  /** Newest OTP for an agent, or null. */
  async function latestOtp(agentId: string, extra: Pick<InboxFilter, 'ownerId' | 'owner'> = {}): Promise<EmailRecord | null> {
    const page = await listInbox({ agentId, types: ['otp'], limit: 1, ...extra });
    return page.items[0] ?? null;
  }

  /** Count of matching entities (same filters as listInbox, creator-pinned). */
  async function countInbox(f: InboxFilter): Promise<number> {
    const n = (await applyFilters(sdk.count().from(EmailSchema), f).fetch()) as bigint;
    return Number(n);
  }

  /** One entity by key. null when it does not exist (or expired). Throws UntrustedEntityError for look-alikes. */
  async function getEmail(entityKey: Hex): Promise<EmailRecord | null> {
    let row: Record<string, unknown>;
    try {
      row = (await sdk.getEntity(entityKey, EmailSchema)) as Record<string, unknown>;
    } catch (e) {
      const err = e as Error;
      if (e instanceof NoEntityFoundError || err.name === 'NoEntityFoundError') return null;
      if (err.name === 'SchemaMismatchError') throw new UntrustedEntityError(entityKey, 'schema');
      throw e;
    }
    return rowToRecord({ ...row, $key: row.$key ?? entityKey }, operator);
  }

  /** Poll until the entity shows up in a creator-pinned query (writes are visible 0.6-2.2 s after the receipt). */
  async function waitForQueryable(entityKey: Hex, o: WaitOptions = {}): Promise<void> {
    const { timeoutMs = 30_000, intervalMs = 1_000, sleep = defaultSleep } = o;
    const start = Date.now();
    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        const page = await sdk
          .select({ $key: true })
          .from(EmailSchema)
          .createdBy(operator)
          .where(eq('$key', keyValue(entityKey)))
          .limit(1)
          .fetch();
        if (page.entities.length > 0) return;
      } catch {
        // transient RPC error or not indexed yet; keep polling until the deadline
      }
      if (Date.now() - start + intervalMs > timeoutMs) {
        throw new QueryTimeoutError(`entity ${entityKey} not queryable after ${timeoutMs}ms (${attempts} polls)`);
      }
      await sleep(intervalMs);
    }
  }

  return { operatorAddress: operator, client, listInbox, latestOtp, getEmail, countInbox, buildInboxQuery, waitForQueryable };
}

export type ArkivReader = ReturnType<typeof createArkivReader>;
