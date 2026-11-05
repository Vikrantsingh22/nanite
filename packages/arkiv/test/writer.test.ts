import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ArkivWriteError,
  EntityTooLargeError,
  InvalidEmailFieldsError,
  SerialQueue,
  createArkivWriter,
  expiryPlan,
  type EmailFields,
  type WriterBackend,
} from '../src/writer';
import { MAX_PAYLOAD_BYTES } from '../src/schema';
import { USER } from './helpers';

const pk = generatePrivateKey();
const OP = privateKeyToAddress(pk);
const tick = () => new Promise<void>((r) => setTimeout(r, 2));

function fields(over: Partial<EmailFields> = {}): EmailFields {
  return {
    agentId: 'alex.nanitecom.eth',
    ownerId: USER,
    type: 'conversation',
    receivedAt: 1_700_000_000,
    threadId: 't1',
    senderHash: 'b'.repeat(64),
    keyIds: ['8899AABBCCDDEEFF', '0011223344556677'],
    ciphertext: new Uint8Array([1, 2, 3]),
    wrappedKeys: new Uint8Array([4]),
    nonce: new Uint8Array(24),
    ...over,
  };
}

interface Fake extends WriterBackend {
  log: string[];
  batches: any[];
  maxConcurrent: number;
}
function fakeBackend(opts: { failFirst?: number; failAlways?: boolean; failMessage?: string } = {}): Fake {
  let nonce = 0;
  let inflight = 0;
  let failures = opts.failFirst ?? 0;
  const f: Fake = {
    log: [],
    batches: [],
    maxConcurrent: 0,
    async predictEntityKeys() {
      f.log.push(`predict:${nonce}`);
      await tick();
      return [{ key: `0x${nonce.toString(16).padStart(64, '0')}` as Hex, salt: BigInt(nonce) }];
    },
    async executeBatch(args: any) {
      inflight++;
      f.maxConcurrent = Math.max(f.maxConcurrent, inflight);
      f.log.push(`exec:${nonce}`);
      f.batches.push(args);
      try {
        await tick();
        if (opts.failAlways || failures-- > 0) {
          const e = new Error(opts.failMessage ?? 'execution reverted');
          e.name = 'EntityMutationError';
          throw e;
        }
        const key = `0x${nonce.toString(16).padStart(64, '0')}` as Hex;
        nonce++;
        return { txHash: `0x${'ab'.repeat(32)}` as Hex, createdEntities: [key] };
      } finally {
        inflight--;
      }
    },
    async extendEntity() {
      f.log.push('extend');
      await tick();
      return { txHash: `0x${'cd'.repeat(32)}` as Hex };
    },
  };
  return f;
}
const writer = (b: Fake, extra = {}) => createArkivWriter({ privateKey: pk, backend: b, sleep: async () => {}, ...extra });

describe('writeEmail', () => {
  it('sends ONE batch: create (predicted salt, permissionless) + changeOwnership to the user', async () => {
    const b = fakeBackend();
    const res = await writer(b).writeEmail({ fields: fields(), owner: USER });
    expect(b.batches).toHaveLength(1);
    const batch = b.batches[0];
    expect(batch.creates).toHaveLength(1);
    expect(batch.creates[0].salt).toBe(0n);
    expect(batch.creates[0].flags).toEqual({ permissionlessExtension: true });
    expect(batch.creates[0].values.keyIds).toBe('0011223344556677,8899aabbccddeeff');
    expect(batch.ownershipChanges).toEqual([{ entityKey: res.entityKey, newOwner: USER }]);
    expect(res.attempts).toBe(1);
  });

  it('never makes OTPs extendable and rejects an explicit request', async () => {
    const b = fakeBackend();
    const w = writer(b);
    await w.writeEmail({ fields: fields({ type: 'otp' }), owner: USER });
    expect(b.batches[0].creates[0].flags).toBeUndefined();
    await expect(w.writeEmail({ fields: fields({ type: 'otp' }), owner: USER, permissionlessExtension: true })).rejects.toThrow(
      InvalidEmailFieldsError,
    );
  });

  it('skips the transfer when the owner is the operator itself', async () => {
    const b = fakeBackend();
    await writer(b).writeEmail({ fields: fields(), owner: OP });
    expect(b.batches[0].ownershipChanges).toBeUndefined();
  });

  it('re-predicts and retries on a revert, bounded', async () => {
    const b = fakeBackend({ failFirst: 1 });
    const res = await writer(b).writeEmail({ fields: fields(), owner: USER });
    expect(res.attempts).toBe(2);
    expect(b.log.filter((l) => l.startsWith('predict'))).toHaveLength(2);

    const bad = fakeBackend({ failAlways: true });
    await expect(writer(bad).writeEmail({ fields: fields(), owner: USER })).rejects.toThrow(ArkivWriteError);
    expect(bad.batches).toHaveLength(3);
  });

  it('does not retry non-revert errors', async () => {
    const b = fakeBackend();
    b.executeBatch = async () => {
      throw new Error('socket hang up');
    };
    await expect(writer(b).writeEmail({ fields: fields(), owner: USER })).rejects.toThrow(/socket hang up/);
  });

  it('size guard: rejects over 125 KiB with EntityTooLargeError and sends nothing', async () => {
    const b = fakeBackend();
    const w = writer(b);
    const big = fields({ ciphertext: new Uint8Array(MAX_PAYLOAD_BYTES) }); // + wrappedKeys + nonce pushes it over
    await expect(w.writeEmail({ fields: big, owner: USER })).rejects.toThrow(EntityTooLargeError);
    expect(b.log).toHaveLength(0);
    const edge = fields({ ciphertext: new Uint8Array(MAX_PAYLOAD_BYTES - 1 - 24), wrappedKeys: new Uint8Array(1) });
    await expect(w.writeEmail({ fields: edge, owner: USER })).resolves.toBeDefined();
  });

  it('validates fields', async () => {
    const w = writer(fakeBackend());
    await expect(w.writeEmail({ fields: fields({ senderHash: 'nope' }), owner: USER })).rejects.toThrow(InvalidEmailFieldsError);
    await expect(w.writeEmail({ fields: fields({ keyIds: ['xyz'] }), owner: USER })).rejects.toThrow(InvalidEmailFieldsError);
    await expect(w.writeEmail({ fields: fields({ type: 'junk' as never }), owner: USER })).rejects.toThrow(InvalidEmailFieldsError);
  });
});

describe('single-flight queue', () => {
  it('serializes parallel writes: concurrency 1, strict predict/exec alternation, FIFO', async () => {
    const b = fakeBackend();
    const w = writer(b);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => w.writeEmail({ fields: fields({ threadId: `t${i}` }), owner: USER })),
    );
    expect(b.maxConcurrent).toBe(1);
    expect(b.log).toEqual(Array.from({ length: 6 }, (_, i) => [`predict:${i}`, `exec:${i}`]).flat());
    expect(b.batches.map((x) => x.creates[0].values.threadId)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
    expect(results.map((r) => r.entityKey)).toEqual(
      Array.from({ length: 6 }, (_, i) => `0x${i.toString(16).padStart(64, '0')}`),
    );
  });

  it('extendEmail shares the same queue', async () => {
    const b = fakeBackend();
    const w = writer(b);
    await Promise.all([
      w.writeEmail({ fields: fields(), owner: USER }),
      w.extendEmail(`0x${'01'.repeat(32)}`),
      w.writeEmail({ fields: fields(), owner: USER }),
    ]);
    expect(b.log).toEqual(['predict:0', 'exec:0', 'extend', 'predict:1', 'exec:1']);
  });

  it('SerialQueue keeps going after a failing task', async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    const a = q.run(async () => {
      await tick();
      order.push(1);
      throw new Error('x');
    });
    const c = q.run(async () => {
      order.push(2);
      return 'ok';
    });
    await expect(a).rejects.toThrow('x');
    await expect(c).resolves.toBe('ok');
    expect(order).toEqual([1, 2]);
    expect(q.size).toBe(0);
  });
});

describe('expiry policy', () => {
  it('otp short (default 300 s), conversation and sent max, overrides honoured', () => {
    expect(expiryPlan('otp')).toEqual({ kind: 'seconds', seconds: 300 });
    expect(expiryPlan('otp', { otpTtlSeconds: 61 })).toEqual({ kind: 'seconds', seconds: 62 });
    expect(expiryPlan('conversation')).toEqual({ kind: 'max' });
    expect(expiryPlan('sent')).toEqual({ kind: 'max' });
    expect(expiryPlan('conversation', { override: 3600 })).toEqual({ kind: 'seconds', seconds: 3600 });
    expect(expiryPlan('otp', { override: 'max' })).toEqual({ kind: 'max' });
    expect(() => expiryPlan('otp', { override: 0 })).toThrow(InvalidEmailFieldsError);
  });
});
