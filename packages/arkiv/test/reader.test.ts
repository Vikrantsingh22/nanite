import { describe, expect, it, vi } from 'vitest';
import {
  InvalidEmailFieldsError,
  QueryTimeoutError,
  UntrustedEntityError,
  createArkivReader,
  decodeCursor,
  encodeCursor,
} from '../src/index';
import { ATTACKER, KEY1, KEY2, OPERATOR, USER, fakeNode, page, rpcEntity } from './helpers';

function reader(handler: Parameters<typeof fakeNode>[0]) {
  const node = fakeNode(handler);
  return { node, r: createArkivReader({ operatorAddress: OPERATOR, client: node.client }) };
}

describe('query building and creator pinning', () => {
  it('pins $creator and schema, orders by receivedAt desc', () => {
    const { r } = reader(() => page([]));
    const q = r.buildInboxQuery({ agentId: 'alex.nanitecom.eth' });
    expect(q).toContain("arkiv.schema = str('nanite.email.v1')");
    expect(q).toContain(`$creator = addr(${OPERATOR})`);
    expect(q).toContain("agentId = str('alex.nanitecom.eth')");
    expect(q).toMatch(/ORDER BY receivedAt:u64 DESC$/);
  });

  it('adds $owner, ownerId, types, before and after', () => {
    const { r } = reader(() => page([]));
    const q = r.buildInboxQuery({
      agentId: 'a',
      owner: USER,
      ownerId: USER,
      types: ['otp', 'sent'],
      before: 200,
      after: 100,
    });
    expect(q).toContain(`$owner = addr(${USER})`);
    expect(q).toContain(`ownerId = addr(${USER})`);
    expect(q).toMatch(/type = str\('otp'\) OR type = str\('sent'\)/);
    expect(q).toContain('receivedAt < u64(200)');
    expect(q).toContain('receivedAt > u64(100)');
    expect(q).toContain(`$creator = addr(${OPERATOR})`);
  });

  it('refuses a missing operator address', () => {
    expect(() => createArkivReader({ operatorAddress: '' as never })).toThrow(InvalidEmailFieldsError);
  });

  it('refuses unknown types, bad limits and bad cursors', async () => {
    const { r } = reader(() => page([]));
    await expect(r.listInbox({ agentId: 'a', types: ['spam' as never] })).rejects.toThrow(InvalidEmailFieldsError);
    await expect(r.listInbox({ agentId: 'a', limit: 101 })).rejects.toThrow(InvalidEmailFieldsError);
    await expect(r.listInbox({ agentId: 'a', limit: 0 })).rejects.toThrow(InvalidEmailFieldsError);
    await expect(r.listInbox({ agentId: 'a', cursor: 'garbage' })).rejects.toThrow(InvalidEmailFieldsError);
  });

  it('rejects rows whose $creator is not the operator even if the node returned them', async () => {
    const { r } = reader(() => page([{ key: KEY1, creator: ATTACKER }]));
    await expect(r.listInbox({ agentId: 'a' })).rejects.toThrow(UntrustedEntityError);
  });
});

describe('listInbox paging', () => {
  it('sends limit/offset, returns typed records and a cursor on a full page', async () => {
    const { r, node } = reader(() => page([{ key: KEY1, receivedAt: 5 }, { key: KEY2, receivedAt: 4 }]));
    const first = await r.listInbox({ agentId: 'a', limit: 2 });
    expect(first.items).toHaveLength(2);
    const rec = first.items[0]!;
    expect(rec.$key).toBe(KEY1);
    expect(rec.$creator).toBe(OPERATOR);
    expect(rec.$owner).toBe(USER);
    expect(rec.$expiresAt).toBe(1000n);
    expect(rec.receivedAt).toBe(5);
    expect(rec.keyIds).toEqual(['0011223344556677', '8899aabbccddeeff']);
    expect(rec.ciphertext).toBeInstanceOf(Uint8Array);
    expect([...rec.ciphertext]).toEqual([1, 2, 3]);
    expect([...rec.nonce]).toEqual([6]);
    expect(first.nextCursor).toBe(encodeCursor(2));

    await r.listInbox({ agentId: 'a', limit: 2, cursor: first.nextCursor! });
    const opts = node.queries()[1]!.params[1] as { limit: string; offset: string };
    expect(opts.limit).toBe('0x2');
    expect(opts.offset).toBe('0x2');
    expect(decodeCursor(encodeCursor(123456))).toBe(123456);
  });

  it('has no cursor on a short page and omits bytes when asked', async () => {
    const { r, node } = reader(() => page([{ key: KEY1 }]));
    const p = await r.listInbox({ agentId: 'a', limit: 5, includeBytes: false });
    expect(p.nextCursor).toBeUndefined();
    const sel = (node.queries()[0]!.params[1] as { select: Record<string, unknown> }).select;
    expect(sel.attributes).not.toHaveProperty('ciphertext');
    expect(sel.attributes).toHaveProperty('receivedAt');
  });

  it('sends the creator pin to the node on every query', async () => {
    const { r, node } = reader(() => page([], 0));
    await r.listInbox({ agentId: 'a' });
    await r.latestOtp('a');
    await r.countInbox({ agentId: 'a' });
    for (const q of node.queries()) expect(q.params[0]).toContain(`$creator = addr(${OPERATOR})`);
  });
});

describe('latestOtp and countInbox', () => {
  it('asks for one otp, newest first', async () => {
    const { r, node } = reader(() => page([{ key: KEY1, type: 'otp' }]));
    const otp = await r.latestOtp('a');
    expect(otp?.type).toBe('otp');
    const [query, opts] = node.queries()[0]!.params as [string, { limit: string }];
    expect(query).toContain("type = str('otp')");
    expect(query).toMatch(/DESC$/);
    expect(opts.limit).toBe('0x1');
  });

  it('returns null when there is no otp', async () => {
    const { r } = reader(() => page([]));
    expect(await r.latestOtp('a')).toBeNull();
  });

  it('counts', async () => {
    const { r } = reader(() => page([], 7));
    expect(await r.countInbox({ agentId: 'a', types: ['otp'] })).toBe(7);
  });
});

describe('getEmail', () => {
  it('returns a trusted entity', async () => {
    const { r } = reader(() => rpcEntity({ key: KEY1 }));
    const e = await r.getEmail(KEY1);
    expect(e?.$key).toBe(KEY1);
    expect(e?.agentId).toBe('alex.nanitecom.eth');
  });
  it('returns null when missing', async () => {
    const { r } = reader(() => null);
    expect(await r.getEmail(KEY1)).toBeNull();
  });
  it('rejects a wrong creator', async () => {
    const { r } = reader(() => rpcEntity({ key: KEY1, creator: ATTACKER }));
    await expect(r.getEmail(KEY1)).rejects.toThrow(UntrustedEntityError);
  });
  it('rejects a wrong schema tag', async () => {
    const { r } = reader(() => rpcEntity({ key: KEY1, schemaTag: 'nanite.email.v0' }));
    await expect(r.getEmail(KEY1)).rejects.toThrow(UntrustedEntityError);
  });
});

describe('waitForQueryable', () => {
  it('polls until the entity appears', async () => {
    let n = 0;
    const { r } = reader(() => page(n++ < 2 ? [] : [{ key: KEY1 }]));
    const sleep = vi.fn(async () => {});
    await r.waitForQueryable(KEY1, { sleep, intervalMs: 1 });
    expect(sleep).toHaveBeenCalledTimes(2);
  });
  it('times out', async () => {
    const { r } = reader(() => page([]));
    await expect(r.waitForQueryable(KEY1, { sleep: async () => {}, timeoutMs: 5, intervalMs: 3 })).rejects.toThrow(
      QueryTimeoutError,
    );
  });
});
