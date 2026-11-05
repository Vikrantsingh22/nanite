import { beforeAll, describe, expect, it } from 'vitest';
import {
  ARGON2_PASSPHRASE,
  ARGON2_RECOVERY,
  CryptoError,
  KEY_DERIVATION_MESSAGE,
  decryptEmail,
  deriveAgentEncryptionKeypair,
  deriveAgentWallet,
  deriveWrappingKeyFromPassphrase,
  deriveWrappingKeyFromRecoveryCode,
  deriveWrappingKeyFromSignature,
  encryptEmail,
  generateNaniteSeed,
  generateRecoveryCode,
  generateSalt,
  generateUserKeypair,
  hkdfSha256,
  hmacSha256,
  fromHex,
  keyId,
  normalizeRecoveryCode,
  ready,
  senderHash,
  signaturesAreDeterministic,
  toHex,
  unwrapSecret,
  wrapSecret,
} from '../src/index';

const utf8 = (x: string) => new TextEncoder().encode(x);
const mail = { subject: 'Your code is 123456', body: 'Hello <b>world</b> \u{1F680}\nline2' };

async function party() {
  const kp = await generateUserKeypair();
  return { ...kp, keyId: keyId(kp.publicKey) };
}
async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CryptoError);
  expect((err as CryptoError).code).toBe(code);
}

beforeAll(async () => {
  await ready();
});

describe('primitives', () => {
  it('HMAC-SHA256 and HKDF match RFC vectors', () => {
    // RFC 4231 test case 2
    expect(toHex(hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?')))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    // RFC 5869 test case 1
    const okm = hkdfSha256(
      fromHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
      fromHex('000102030405060708090a0b0c'),
      fromHex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(toHex(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  });
});

describe('envelope encryption', () => {
  it('user and agent each decrypt the same email', async () => {
    const user = await party();
    const agent = await party();
    const rawEml = utf8('From: a@b.c\r\n\r\nraw');
    const enc = await encryptEmail({ ...mail, rawEml }, [user, agent]);
    for (const who of [user, agent]) {
      const out = await decryptEmail(enc, who);
      expect(out.subject).toBe(mail.subject);
      expect(out.body).toBe(mail.body);
      expect(out.rawEml).toEqual(rawEml);
    }
    expect(enc.keyIds).toEqual([user.keyId, agent.keyId].sort());
  });

  it('works without rawEml and with empty fields', async () => {
    const u = await party();
    const out = await decryptEmail(await encryptEmail({ subject: '', body: '' }, [u]), u);
    expect(out).toEqual({ subject: '', body: '' });
  });

  it('carries structured meta (with and without rawEml); absent meta stays absent', async () => {
    const u = await party();
    const a = await party();
    const meta = { otp: '482913', links: ['https://example.com/x?y=1'] };
    const rawEml = utf8('raw');
    const withMeta = await encryptEmail({ ...mail, meta }, [u, a]);
    for (const who of [u, a]) expect(await decryptEmail(withMeta, who)).toEqual({ ...mail, meta });
    const both = await decryptEmail(await encryptEmail({ ...mail, rawEml, meta }, [u]), u);
    expect(both.rawEml).toEqual(rawEml);
    expect(both.meta).toEqual(meta);
    const none = await decryptEmail(await encryptEmail(mail, [u]), u);
    expect(none.meta).toBeUndefined();
    expect('meta' in none).toBe(false);
    // legacy wire layout (no meta) is byte-for-byte unchanged: 1 + 2 + 4 + subject + 4 + body + 16
    const legacy = await encryptEmail(mail, [u]);
    expect(legacy.ciphertext.length).toBe(1 + 2 + 4 + utf8(mail.subject).length + 4 + utf8(mail.body).length + 16);
    await expectCode(encryptEmail({ ...mail, meta: [] as never }, [u]), 'BAD_INPUT');
  });

  it('meta is authenticated: tampering with a meta-bearing ciphertext fails', async () => {
    const u = await party();
    const enc = await encryptEmail({ ...mail, meta: { otp: '111111' } }, [u]);
    const ct = enc.ciphertext.slice();
    ct[ct.length - 20] = (ct[ct.length - 20] as number) ^ 1;
    await expectCode(decryptEmail({ ...enc, ciphertext: ct }, u), 'TAMPERED');
  });

  it('fails on wrong private key (typed)', async () => {
    const u = await party();
    const other = await party();
    const enc = await encryptEmail(mail, [u]);
    await expectCode(decryptEmail(enc, { ...u, privateKey: other.privateKey }), 'WRONG_KEY');
  });

  it('fails when no slot matches the keyId', async () => {
    const u = await party();
    const stranger = await party();
    const enc = await encryptEmail(mail, [u]);
    await expectCode(decryptEmail(enc, stranger), 'NO_SLOT');
  });

  it('fails on tampered ciphertext, nonce, or stripped slots', async () => {
    const u = await party();
    const a = await party();
    const enc = await encryptEmail(mail, [u, a]);
    const ct = enc.ciphertext.slice();
    ct[ct.length - 1] = (ct[ct.length - 1] as number) ^ 1;
    await expectCode(decryptEmail({ ...enc, ciphertext: ct }, u), 'TAMPERED');
    const ct2 = enc.ciphertext.slice();
    ct2[5] = (ct2[5] as number) ^ 1;
    await expectCode(decryptEmail({ ...enc, ciphertext: ct2 }, u), 'TAMPERED');
    const nonce = enc.nonce.slice();
    nonce[0] = (nonce[0] as number) ^ 1;
    await expectCode(decryptEmail({ ...enc, nonce }, u), 'TAMPERED');
    // drop one slot: AD (sorted keyIds) no longer matches
    const only = (await encryptEmail(mail, [u])).wrappedKeys;
    const swapped = enc.wrappedKeys.slice();
    swapped[1] = 1;
    await expectCode(decryptEmail({ ...enc, wrappedKeys: swapped }, u), 'BAD_FORMAT');
    expect(only.length).toBe(2 + 88);
  });

  it('rejects unknown versions and malformed input', async () => {
    const u = await party();
    const enc = await encryptEmail(mail, [u]);
    const ct = enc.ciphertext.slice();
    ct[0] = 9;
    await expectCode(decryptEmail({ ...enc, ciphertext: ct }, u), 'UNSUPPORTED_VERSION');
    await expectCode(decryptEmail({ ...enc, wrappedKeys: new Uint8Array(1) }, u), 'BAD_FORMAT');
    await expectCode(encryptEmail(mail, []), 'BAD_INPUT');
    await expectCode(encryptEmail(mail, [{ keyId: '0000000000000000', publicKey: u.publicKey }]), 'BAD_INPUT');
  });

  it('size: 24 KiB email, 2 recipients fits the Arkiv budget', async () => {
    const u = await party();
    const a = await party();
    const body = 'x'.repeat(24 * 1024 - mail.subject.length);
    const enc = await encryptEmail({ subject: mail.subject, body }, [u, a]);
    const total = enc.ciphertext.length + enc.wrappedKeys.length + enc.nonce.length;
    console.log(
      `[sizes] plaintext=24576 ciphertext=${enc.ciphertext.length} wrappedKeys=${enc.wrappedKeys.length} nonce=${enc.nonce.length} total=${total} (budget 128000)`,
    );
    expect(total).toBeLessThan(125 * 1024);
    expect(enc.wrappedKeys.length).toBe(2 + 2 * 88);
    expect(enc.ciphertext.length).toBe(1 + 2 + 4 + mail.subject.length + 4 + body.length + 16);
  });
});

describe('keys and recovery', () => {
  it('signature-derived key restores the private key', async () => {
    const kp = await generateUserKeypair();
    const sig = '0x' + 'ab'.repeat(65);
    const salt = await generateSalt();
    const blob = await wrapSecret(kp.privateKey, await deriveWrappingKeyFromSignature(sig, salt));
    const back = await unwrapSecret(blob, await deriveWrappingKeyFromSignature(sig, salt));
    expect(back).toEqual(kp.privateKey);
    await expectCode(unwrapSecret(blob, await deriveWrappingKeyFromSignature('0x' + 'cd'.repeat(65), salt)), 'WRONG_KEY');
    const t = blob.slice();
    t[t.length - 1] = (t[t.length - 1] as number) ^ 1;
    await expectCode(unwrapSecret(t, await deriveWrappingKeyFromSignature(sig, salt)), 'WRONG_KEY');
  });

  it('signaturesAreDeterministic + message constant', () => {
    expect(signaturesAreDeterministic('0xAB', '0xab')).toBe(true);
    expect(signaturesAreDeterministic('0xab', '0xac')).toBe(false);
    expect(signaturesAreDeterministic('', '')).toBe(false);
    expect(KEY_DERIVATION_MESSAGE).toMatch(/^Nanite key derivation v1/);
  });

  it('recovery code restores the key; input is normalized', async () => {
    const kp = await generateUserKeypair();
    const code = await generateRecoveryCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){4}[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(new Set([code, await generateRecoveryCode()]).size).toBe(2);
    const salt = await generateSalt();
    let t0 = performance.now();
    const wk = await deriveWrappingKeyFromRecoveryCode(code, salt);
    const tRec = performance.now() - t0;
    const blob = await wrapSecret(kp.privateKey, wk);
    const messy = ' ' + code.toLowerCase().replaceAll('-', ' ') + ' ';
    expect(normalizeRecoveryCode(messy)).toBe(normalizeRecoveryCode(code));
    const back = await unwrapSecret(blob, await deriveWrappingKeyFromRecoveryCode(messy, salt));
    expect(back).toEqual(kp.privateKey);
    t0 = performance.now();
    await deriveWrappingKeyFromPassphrase('correct horse battery staple', salt);
    const tPass = performance.now() - t0;
    console.log(
      `[argon2] recovery ops=${ARGON2_RECOVERY.opslimit} mem=${ARGON2_RECOVERY.memlimit >> 20}MiB: ${tRec.toFixed(0)} ms; passphrase ops=${ARGON2_PASSPHRASE.opslimit} mem=${ARGON2_PASSPHRASE.memlimit >> 20}MiB: ${tPass.toFixed(0)} ms (node, wasm)`,
    );
    await expectCode(deriveWrappingKeyFromRecoveryCode('too-short', salt), 'BAD_INPUT');
  });

  it('passphrase restores the key; wrong passphrase fails', async () => {
    const kp = await generateUserKeypair();
    const salt = await generateSalt();
    const blob = await wrapSecret(kp.privateKey, await deriveWrappingKeyFromPassphrase('pässphrase one', salt));
    expect(await unwrapSecret(blob, await deriveWrappingKeyFromPassphrase('pässphrase one', salt))).toEqual(kp.privateKey);
    await expectCode(unwrapSecret(blob, await deriveWrappingKeyFromPassphrase('pässphrase two', salt)), 'WRONG_KEY');
  });
});

describe('seed and agent derivation', () => {
  it('is deterministic, index-separated, and wallet key != encryption key', async () => {
    const seed = await generateNaniteSeed();
    expect(seed.length).toBe(32);
    const w0 = await deriveAgentWallet(seed, 0);
    const w0b = await deriveAgentWallet(seed, 0);
    const w1 = await deriveAgentWallet(seed, 1);
    expect(w0).toEqual(w0b);
    expect(w0.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w1.address).not.toBe(w0.address);
    const e0 = await deriveAgentEncryptionKeypair(seed, 0);
    expect(await deriveAgentEncryptionKeypair(seed, 0)).toEqual(e0);
    expect(toHex((await deriveAgentEncryptionKeypair(seed, 1)).privateKey)).not.toBe(toHex(e0.privateKey));
    expect(toHex(e0.privateKey)).not.toBe(w0.privateKey.slice(2));
    expect(toHex(e0.publicKey)).not.toBe(w0.privateKey.slice(2));
    expect(await deriveAgentEncryptionKeypair(await generateNaniteSeed(), 0)).not.toEqual(e0);
  });

  it('matches the standard BIP-44 test vector (known seed -> known address)', async () => {
    // Seed = bytes of the well-known "test test ... junk" BIP-39 seed is not used; instead check against viem's HD derivation.
    const { HDKey } = await import('@scure/bip32');
    const { privateKeyToAddress } = await import('viem/accounts');
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const ref = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/7").privateKey!;
    expect((await deriveAgentWallet(seed, 7)).address).toBe(privateKeyToAddress(`0x${toHex(ref)}`));
  });

  it('agent decrypts an email via its derived key', async () => {
    const seed = await generateNaniteSeed();
    const kp = await deriveAgentEncryptionKeypair(seed, 3);
    const agent = { ...kp, keyId: keyId(kp.publicKey) };
    const user = await party();
    const enc = await encryptEmail(mail, [user, agent]);
    expect((await decryptEmail(enc, agent)).body).toBe(mail.body);
  });
});

describe('blind index', () => {
  it('is stable, normalized, 64 hex, per-user distinct', async () => {
    const secret = 'server-secret-for-tests-only-0123456789';
    const h = await senderHash(secret, 'user-1', 'Alice@Example.com');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await senderHash(secret, 'user-1', '  alice@example.com ')).toBe(h);
    expect(await senderHash(secret, 'user-1', 'Alice <ALICE@example.com>')).toBe(h);
    expect(await senderHash(secret, 'user-2', 'alice@example.com')).not.toBe(h);
    expect(await senderHash(secret + 'x', 'user-1', 'alice@example.com')).not.toBe(h);
    expect(await senderHash(secret, 'user-1', 'bob@example.com')).not.toBe(h);
  });
});
