/*
 * Opt-in LIVE test (writes two entities on the Arkiv Rabdi testnet, costs ~0.002 tGLM):
 *
 *   docker compose up -d db
 *   docker compose run --rm tools npm run test:live -w apps/api
 *
 * Run it ALONE (it replaces the seeded dev keys, which would race inbound.test.ts).
 * Flow: fresh user + agent X25519 keypairs -> stored (public halves) for the seeded vikrant/alex ->
 * the seeded user's wallet is switched to ARKIV_TEST_MNEMONIC index 4 (restored afterwards) ->
 * fake MailProvider (FAKE content) + the REAL Arkiv writer (operator = index 3) through the real
 * pipeline -> read back with the creator-pinned reader -> decrypt with BOTH private keys (in memory only).
 * Keys are never printed. Results are appended to apps/api/LIVE-CHECK.md (entity keys + tx hashes).
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { decryptEmail, ready } from "@nanite/crypto";
import { createDb } from "@nanite/db";
import { createArkivReader } from "@nanite/arkiv";
import { createRealArkivWriter } from "../src/arkiv/arkiv-writer.js";
import { handleInboundEvent } from "../src/inbound/pipeline.js";
import { createFakeMailProvider } from "../src/mail/fake.js";
import { provisionDevKeys } from "../scripts/provision-dev-keys.js";

const live = process.env.LIVE_ARKIV === "1" && !!process.env.ARKIV_TEST_MNEMONIC;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
const REPORT = resolve(dirname(fileURLToPath(import.meta.url)), "../LIVE-CHECK.md");

const tag = Date.now().toString(36);
const CONV = {
  subject: `FAKE live conversation ${tag}`,
  text: `FAKE body ${tag}. See https://example.com/live-check for details.`,
};
const OTP_CODE = "731942";
const OTP = {
  subject: `FAKE live verification code ${tag}`,
  text: `FAKE: your verification code is ${OTP_CODE}. It expires in 5 minutes.`,
};

describe.skipIf(!live)("live inbound -> Arkiv (Rabdi)", () => {
  const handle = createDb(DATABASE_URL, { max: 2 });
  let originalWallet: string | undefined;
  let userId: string | undefined;

  beforeAll(async () => {
    await ready();
  });
  afterAll(async () => {
    if (userId && originalWallet) {
      await handle.client`update users set wallet_address = ${originalWallet} where id = ${userId}`;
    }
    await handle.client`delete from webhook_events where provider_event_id like 'msg_live_%'`;
    await handle.close();
  });

  it("writes conversation + OTP mail on chain and both readers decrypt them", async () => {
    const m = process.env.ARKIV_TEST_MNEMONIC!;
    const operator = mnemonicToAccount(m, { addressIndex: 3 });
    const owner = mnemonicToAccount(m, { addressIndex: 4 });
    const accessKey = process.env.ARKIV_ACCESS_KEY ?? "";

    const keys = await provisionDevKeys(handle.db);
    userId = keys.userId;
    const [u] = await handle.client`select wallet_address from users where id = ${keys.userId}`;
    originalWallet = u!.wallet_address as string;
    await handle.client`update users set wallet_address = ${owner.address.toLowerCase()} where id = ${keys.userId}`;

    const real = createRealArkivWriter({
      privateKey: bytesToHex(operator.getHdKey().privateKey!) as Hex,
      accessKey,
    });
    const provider = createFakeMailProvider({
      webhookSecret: "whsec_" + Buffer.from("live-test-secret-0123456789").toString("base64"),
      emails: {
        [`em_live_conv_${tag}`]: { subject: CONV.subject, text: CONV.text, from: "FAKE <fake.sender@example.com>" },
        [`em_live_otp_${tag}`]: { subject: OTP.subject, text: OTP.text, from: "FAKE <fake.sender@example.com>" },
      },
    });
    const deps = { db: handle.db, provider, arkiv: real.port, senderHashSecret: "live-sender-hash-secret-0123456789" };

    const results: { label: string; eventId: string; entityKey: string; txHash: string }[] = [];
    for (const [label, emailId] of [
      ["conversation", `em_live_conv_${tag}`],
      ["otp", `em_live_otp_${tag}`],
    ] as const) {
      const eventId = `msg_live_${label}_${tag}`;
      const res = await handleInboundEvent(
        deps,
        { kind: "received", providerEventId: eventId, emailId, recipients: ["alex@nanite.test"] },
        () => undefined,
      );
      expect(res).toEqual({ http: 200, status: "stored" });
      const [row] = await handle.client`
        select a.entity_key, a.tx_hash, a.status from arkiv_writes a
        join webhook_events e on e.id = a.webhook_event_id where e.provider_event_id = ${eventId}`;
      expect(row!.status).toBe("confirmed");
      results.push({ label, eventId, entityKey: row!.entity_key as string, txHash: row!.tx_hash as string });
    }

    const reader = createArkivReader({ operatorAddress: operator.address, accessKey });
    const lines: string[] = [];
    const expires: Record<string, bigint> = {};
    for (const r of results) {
      await real.writer.waitForQueryable(r.entityKey as Hex, { timeoutMs: 90_000 });
      const rec = await reader.getEmail(r.entityKey as Hex);
      expect(rec).not.toBeNull();
      expect(rec!.$creator.toLowerCase()).toBe(operator.address.toLowerCase());
      expect(rec!.$owner.toLowerCase()).toBe(owner.address.toLowerCase());
      expect(rec!.agentId).toBe("alex.vikrant.nanitecom.eth");
      expect(rec!.type).toBe(r.label);
      expect(rec!.keyIds).toEqual([keys.user.keyId, keys.agent.keyId].sort());
      expires[r.label] = rec!.$expiresAt;

      const want = r.label === "otp" ? OTP : CONV;
      for (const [who, k] of [
        ["user", keys.user],
        ["agent", keys.agent],
      ] as const) {
        const plain = await decryptEmail(rec!, { keyId: k.keyId, publicKey: k.publicKey, privateKey: k.privateKey });
        expect(plain.subject).toBe(want.subject);
        expect(plain.body).toBe(want.text);
        if (r.label === "otp") expect(plain.meta?.otp).toBe(OTP_CODE);
        else expect(plain.meta?.links).toEqual(["https://example.com/live-check"]);
        expect(plain.rawEml).toBeUndefined();
        void who;
      }
      // listing is creator-pinned and finds it too
      const page = await reader.listInbox({ agentId: rec!.agentId, ownerId: owner.address });
      expect(page.items.map((i) => i.$key)).toContain(rec!.$key);
      lines.push(
        `| ${r.label} | \`${r.entityKey}\` | \`${r.txHash}\` | $owner = index-4 wallet, $creator = operator (index 3) | decrypted OK with user AND agent key${r.label === "otp" ? "; meta.otp matches" : "; meta.links match"} |`,
      );
    }
    // OTP lives 5 minutes, conversation the chain maximum.
    expect(expires.otp!).toBeLessThan(expires.conversation!);

    if (!existsSync(REPORT)) {
      writeFileSync(
        REPORT,
        "# Live check: inbound pipeline -> real Arkiv writer (Rabdi testnet)\n\nGenerated by `test/live-inbound.test.ts` (LIVE_ARKIV=1). Content is FAKE; no keys or plaintext are recorded here.\nExplorer: https://rabdi.explorer.arkiv.network\n",
      );
    }
    appendFileSync(
      REPORT,
      `\n## Run ${new Date().toISOString()}\n\n| type | entity key | tx hash | ownership | result |\n| --- | --- | --- | --- | --- |\n${lines.join("\n")}\n\nOTP expiry block ${expires.otp} < conversation expiry block ${expires.conversation}.\n`,
    );
  }, 240_000);
});
