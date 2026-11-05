import { beforeAll, describe, expect, it } from 'vitest';
import {
  CryptoError,
  decryptEmail,
  encryptEmail,
  prepareKeys,
  probeDeterministicSignature,
  ready,
  unlockWithBundle,
} from '../src/index';

const SIG = '0x' + 'ab'.repeat(65);

beforeAll(async () => {
  await ready();
});

describe('onboarding (shared by the web app and the live scripts)', () => {
  it('prepareKeys -> unlockWithBundle round-trips with the wallet signature and the recovery code', async () => {
    const prepared = await prepareKeys({ kind: 'signature', signature: SIG });
    const viaWallet = await unlockWithBundle(prepared.bundle, { kind: 'signature', signature: SIG });
    expect(viaWallet.keyId).toBe(prepared.bundle.keyId);
    expect(Buffer.from(viaWallet.privateKey)).toEqual(Buffer.from(prepared.unlocked.privateKey));
    expect(Buffer.from(viaWallet.seed)).toEqual(Buffer.from(prepared.unlocked.seed));
    const viaRecovery = await unlockWithBundle(prepared.bundle, { kind: 'recovery', code: prepared.recoveryCode });
    expect(Buffer.from(viaRecovery.seed)).toEqual(Buffer.from(prepared.unlocked.seed));
    // the unlocked key really decrypts mail sealed to the bundle's public key
    const enc = await encryptEmail({ subject: 's', body: 'b', meta: { from: 'a@b.example', messageId: '<1@b.example>' } }, [
      { keyId: viaWallet.keyId, publicKey: viaWallet.publicKey },
    ]);
    const plain = await decryptEmail(enc, viaWallet);
    expect(plain.meta).toEqual({ from: 'a@b.example', messageId: '<1@b.example>' });
  });

  it('a different signature does not unlock', async () => {
    const prepared = await prepareKeys({ kind: 'signature', signature: SIG });
    await expect(unlockWithBundle(prepared.bundle, { kind: 'signature', signature: '0x' + 'cd'.repeat(65) })).rejects.toBeInstanceOf(CryptoError);
  });

  it('probeDeterministicSignature compares two signatures of the key-derivation message', async () => {
    expect(await probeDeterministicSignature(async () => SIG)).toEqual({ deterministic: true, signature: SIG });
    let n = 0;
    const flaky = async () => '0x' + (n++ % 2 ? 'ab' : 'cd').repeat(65);
    expect((await probeDeterministicSignature(flaky)).deterministic).toBe(false);
  });
});
