// Generates e2e/tests/fixtures/inbox-fixture.json: a key bundle wrapped with the mocked wallet
// signature plus REAL @nanite/crypto ciphertext for the inbox e2e (test data only, random keys).
// Run: docker compose run --rm tools npx tsx scripts/e2e/make-inbox-fixture.ts
import { mkdirSync, writeFileSync } from "node:fs";
import {
  deriveWrappingKeyFromRecoveryCode,
  deriveWrappingKeyFromSignature,
  encryptEmail,
  generateNaniteSeed,
  generateRecoveryCode,
  generateSalt,
  generateUserKeypair,
  keyId,
  wrapSecret,
} from "@nanite/crypto";

// Same value as FAKE_SIG in e2e/tests/onboarding.spec.ts (what the mocked wallet returns for personal_sign).
const SIGNATURE = "0x" + "ab".repeat(65);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

const kp = await generateUserKeypair();
const other = await generateUserKeypair(); // a reader that is NOT the user: for the undecryptable case
const seed = await generateNaniteSeed();
const walletSalt = await generateSalt();
const recoverySalt = await generateSalt();
const wrapKey = await deriveWrappingKeyFromSignature(SIGNATURE, walletSalt);
const recKey = await deriveWrappingKeyFromRecoveryCode(await generateRecoveryCode(), recoverySalt);

const bundle = {
  publicKey: b64(kp.publicKey),
  keyId: keyId(kp.publicKey),
  walletSalt: b64(walletSalt),
  recoverySalt: b64(recoverySalt),
  wrappedPrivateKeyWallet: b64(await wrapSecret(kp.privateKey, wrapKey)),
  wrappedPrivateKeyRecovery: b64(await wrapSecret(kp.privateKey, recKey)),
  wrappedSeedWallet: b64(await wrapSecret(seed, wrapKey)),
  wrappedSeedRecovery: b64(await wrapSecret(seed, recKey)),
  passphraseMode: false,
};

const me = { keyId: keyId(kp.publicKey), publicKey: kp.publicKey };
const notMe = { keyId: keyId(other.publicKey), publicKey: other.publicKey };

const HTML_BODY = `<!doctype html><html><head>
<meta http-equiv="refresh" content="0;url=http://evil-refresh.test/redirect">
<base href="http://evil-base.test/">
<link rel="stylesheet" href="http://evil-css.test/x.css">
<style>h2{color:#0a7d4f}</style>
</head><body>
<h2>Your weekly digest</h2>
<p id="msg">HTMLMARKER rendered inside the sandbox.</p>
<img id="pixel" src="http://evil-images.test/pixel.png" width="1" height="1" alt="">
<img id="banner" src="https://evil-images.test/banner.png" alt="banner">
<div style="background:url(http://evil-images.test/bg.png)">styled</div>
<a href="http://evil-links.test/click">click me</a>
<script>fetch("http://evil-script.test/ping");document.title="pwned";</script>
<img src="x" onerror="fetch('http://evil-onerror.test/ping')">
</body></html>`;

const specs = [
  { name: "welcome", type: "conversation", subject: "Welcome to Nanite", body: "Hi there,\n\nThis is plain text. <b>not bold</b> and <script>alert(1)</script> stay literal.\n\nThanks!", meta: { links: ["https://example.com/verify?token=abc"] }, to: [me] },
  { name: "html", type: "conversation", subject: "Weekly digest (HTML)", body: HTML_BODY, meta: { links: ["http://evil-links.test/click"] }, to: [me] },
  { name: "otp", type: "otp", subject: "Your Acme verification code", body: "Your verification code is 482913. It expires in 5 minutes.", meta: { otp: "482913", links: [] }, to: [me] },
  { name: "foreign", type: "conversation", subject: "Not for you", body: "sealed to someone else", meta: { links: [] }, to: [notMe] },
] as const;

const emails = [];
for (const s of specs) {
  const enc = await encryptEmail({ subject: s.subject, body: s.body, meta: s.meta as never }, [...s.to]);
  emails.push({
    name: s.name,
    type: s.type,
    subject: s.subject,
    keyIds: enc.keyIds,
    ciphertext: b64(enc.ciphertext),
    wrappedKeys: b64(enc.wrappedKeys),
    nonce: b64(enc.nonce),
  });
}

mkdirSync("e2e/tests/fixtures", { recursive: true });
writeFileSync("e2e/tests/fixtures/inbox-fixture.json", JSON.stringify({ signature: SIGNATURE, bundle, emails }, null, 2) + "\n");
console.log(`wrote e2e/tests/fixtures/inbox-fixture.json (${emails.length} emails, keyId ${bundle.keyId})`);
