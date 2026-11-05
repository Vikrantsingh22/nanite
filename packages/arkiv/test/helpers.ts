import { createPublicClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { custom, type Address, type Hex } from 'viem';
import type { ArkivPublicClient } from '../src/reader';

export const OPERATOR = '0x38CbFe210ce51A97fE698982952412AB12ad3dab' as Address;
export const ATTACKER = '0xfAD31e74F1Cb69046BBB2e4A15ce653beE6936C0' as Address;
export const USER = '0xC0575045B1acacC1349e3e5f8bE20FBA3a8E287b' as Address;
export const KEY1 = `0x${'11'.repeat(32)}` as Hex;
export const KEY2 = `0x${'22'.repeat(32)}` as Hex;

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;
const qty = (n: number | bigint) => `0x${n.toString(16)}`;

export interface FakeRow {
  key: Hex;
  creator?: Address;
  owner?: Address;
  agentId?: string;
  type?: string;
  receivedAt?: number;
  schemaTag?: string;
  expiresAt?: number;
}

/** Build an arkiv_query/arkiv_getEntity entity in the node's JSON shape. Bytes are dummy values. */
export function rpcEntity(r: FakeRow) {
  return {
    key: r.key,
    owner: r.owner ?? USER,
    creator: r.creator ?? OPERATOR,
    createdAt: qty(1),
    updatedAt: qty(1),
    expiresAt: qty(r.expiresAt ?? 1000),
    attributes: [
      { name: 'arkiv.schema', type: 'str', value: r.schemaTag ?? 'nanite.email.v1' },
      { name: 'agentId', type: 'str', value: r.agentId ?? 'alex.nanitecom.eth' },
      { name: 'ownerId', type: 'addr', value: USER },
      { name: 'type', type: 'str', value: r.type ?? 'conversation' },
      { name: 'receivedAt', type: 'u64', value: qty(r.receivedAt ?? 1_700_000_000) },
      { name: 'threadId', type: 'str', value: 't1' },
      { name: 'senderHash', type: 'str', value: 'a'.repeat(64) },
      { name: 'keyIds', type: 'str', value: '0011223344556677,8899aabbccddeeff' },
      { name: 'ciphertext', type: 'bytes', value: hex(new Uint8Array([1, 2, 3])) },
      { name: 'wrappedKeys', type: 'bytes', value: hex(new Uint8Array([4, 5])) },
      { name: 'nonce', type: 'bytes', value: hex(new Uint8Array([6])) },
    ],
  };
}

export interface RpcCall {
  method: string;
  params: unknown[];
}

/** A real SDK public client whose transport is an in-memory fake node. */
export function fakeNode(handler: (c: RpcCall) => unknown) {
  const calls: RpcCall[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const c = { method, params: (params ?? []) as unknown[] };
      calls.push(c);
      return handler(c);
    },
  });
  const client = createPublicClient({ chain: rabdi({ accessKey: 'test' }), transport }) as unknown as ArkivPublicClient;
  return { client, calls, queries: () => calls.filter((c) => c.method === 'arkiv_query') };
}

export const page = (rows: FakeRow[], count?: number) => ({
  data: rows.map(rpcEntity),
  blockNumber: qty(10),
  ...(count !== undefined ? { count: qty(count) } : {}),
});
