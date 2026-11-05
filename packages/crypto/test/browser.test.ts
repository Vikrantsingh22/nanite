// @vitest-environment jsdom
// Runs the core flows with a DOM-like global and Node-only globals removed, to show the
// shared path needs only Web APIs (Uint8Array, TextEncoder, WebAssembly, crypto.getRandomValues).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decryptEmail,
  deriveAgentEncryptionKeypair,
  deriveAgentWallet,
  deriveWrappingKeyFromRecoveryCode,
  encryptEmail,
  generateNaniteSeed,
  generateRecoveryCode,
  generateSalt,
  generateUserKeypair,
  keyId,
  ready,
  unwrapSecret,
  wrapSecret,
} from '../src/index';

describe('browser-like environment', () => {
  it('has a window and no Buffer', () => {
    expect(typeof window).toBe('object');
  });

  it('encrypt/decrypt, wrap/unwrap, derivation work without Node globals', async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const savedBuffer = g.Buffer;
    g.Buffer = undefined;
    try {
      await ready();
      const kp = await generateUserKeypair();
      const me = { ...kp, keyId: keyId(kp.publicKey) };
      const seed = await generateNaniteSeed();
      const ak = await deriveAgentEncryptionKeypair(seed, 0);
      const agent = { ...ak, keyId: keyId(ak.publicKey) };
      const enc = await encryptEmail({ subject: 's', body: 'b', meta: { otp: '1234' } }, [me, agent]);
      expect((await decryptEmail(enc, me)).body).toBe('b');
      expect((await decryptEmail(enc, me)).meta).toEqual({ otp: '1234' });
      expect((await decryptEmail(enc, agent)).subject).toBe('s');
      const code = await generateRecoveryCode();
      const salt = await generateSalt();
      const wk = await deriveWrappingKeyFromRecoveryCode(code, salt);
      expect(await unwrapSecret(await wrapSecret(kp.privateKey, wk), wk)).toEqual(kp.privateKey);
      expect((await deriveAgentWallet(seed, 0)).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    } finally {
      g.Buffer = savedBuffer;
    }
  });

  it('source imports no node:* modules', () => {
    const dir = join(__dirname, '..', 'src');
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text, f).not.toMatch(/from\s+['"]node:|require\(|process\.|Buffer\./);
    }
  });
});
