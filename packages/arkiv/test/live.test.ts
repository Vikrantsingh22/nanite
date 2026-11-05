// Opt-in live test against Rabdi: LIVE_ARKIV=1 npm run test:live -w packages/arkiv
// Writes ONE tiny email (1-hour expiry) with the funded W3 operator wallet (ARKIV_TEST_MNEMONIC
// index 3), transfers it to index 4, and reads it back through listInbox with the $creator pin.
// The private key is derived in memory and never printed.
import { bytesToHex, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { createArkivReader } from '../src/index';
import { createArkivWriter } from '../src/writer';

const live = process.env.LIVE_ARKIV === '1' && !!process.env.ARKIV_TEST_MNEMONIC;

describe.skipIf(!live)('live Rabdi', () => {
  it('writes, transfers and reads back one email', async () => {
    const m = process.env.ARKIV_TEST_MNEMONIC!;
    const operator = mnemonicToAccount(m, { addressIndex: 3 });
    const user = mnemonicToAccount(m, { addressIndex: 4 });
    const privateKey = bytesToHex(operator.getHdKey().privateKey!) as Hex;
    const accessKey = process.env.ARKIV_ACCESS_KEY ?? '';

    const writer = createArkivWriter({ privateKey, accessKey });
    const reader = createArkivReader({ operatorAddress: operator.address, accessKey });
    const agentId = `live-${Date.now()}.nanitecom.eth`;

    const res = await writer.writeEmail({
      owner: user.address,
      expiresIn: 3600,
      fields: {
        agentId,
        ownerId: user.address,
        type: 'conversation',
        receivedAt: Math.floor(Date.now() / 1000),
        threadId: 'live-thread',
        senderHash: '0'.repeat(64),
        keyIds: ['0011223344556677'],
        ciphertext: new Uint8Array([1, 2, 3, 4]),
        wrappedKeys: new Uint8Array([5, 6]),
        nonce: new Uint8Array(24),
      },
    });
    console.log(`LIVE entityKey=${res.entityKey} txHash=${res.txHash} attempts=${res.attempts}`);

    await writer.waitForQueryable(res.entityKey, { timeoutMs: 60_000 });
    const page = await reader.listInbox({ agentId });
    expect(page.items).toHaveLength(1);
    const rec = page.items[0]!;
    expect(rec.$key).toBe(res.entityKey);
    expect(rec.$creator).toBe(operator.address);
    expect(rec.$owner).toBe(user.address);
    expect([...rec.ciphertext]).toEqual([1, 2, 3, 4]);
    console.log(`LIVE query=${reader.buildInboxQuery({ agentId })} expiresAtBlock=${rec.$expiresAt}`);

    const one = await reader.getEmail(res.entityKey);
    expect(one?.$owner).toBe(user.address);
    expect(await reader.countInbox({ agentId })).toBe(1);
  });
});
