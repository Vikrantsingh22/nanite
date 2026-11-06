/*
 * Opt-in LIVE test (writes one entity on Arkiv Rabdi, ~0.001 tGLM). Run it ALONE:
 *   docker compose run --rm tools npm run test:live-agent -w apps/api
 * Flow: key provisioned for alex (custody nanite, in-process master key) AFTER which a fresh FAKE
 * email goes through the signed webhook flow with the REAL writer; then the agent token fetches
 * /v1/inbox and /v1/emails/:key from the real creator-pinned reader and gets it decrypted.
 * Result (keys and a pass/fail line, no content) is appended to apps/api/LIVE-CHECK.md.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { bytesToHex, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { ready } from "@nanite/crypto";
import { createDb, seedDemo, userKeys } from "@nanite/db";
import { generateUserKeypair, keyId } from "@nanite/crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createRealArkivWriter } from "../src/arkiv/arkiv-writer.js";
import { parseMasterKey, provisionNaniteAgentKey } from "../src/agent-api/keys.js";
import { issueAgentToken } from "../src/agent-api/tokens.js";
import { createFakeMailProvider } from "../src/mail/fake.js";
import { signSvix } from "../src/mail/svix.js";

const live = process.env.LIVE_ARKIV === "1" && !!process.env.ARKIV_TEST_MNEMONIC;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
const REPORT = resolve(dirname(fileURLToPath(import.meta.url)), "../LIVE-CHECK.md");
const SECRET = "whsec_" + Buffer.from("live-agent-secret-0123456789").toString("base64");
const tag = Date.now().toString(36);
const SUBJECT = `FAKE agent-api live ${tag}`;
const BODY = `FAKE body ${tag} https://example.com/agent-live`;

describe.skipIf(!live)("live agent API (Rabdi)", () => {
  const handle = createDb(DATABASE_URL, { max: 2 });
  let userId: string | undefined;
  let originalWallet: string | undefined;
  afterAll(async () => {
    if (userId && originalWallet) await handle.client`update users set wallet_address = ${originalWallet} where id = ${userId}`;
    await handle.client`delete from webhook_events where provider_event_id like 'msg_agentlive_%'`;
    await handle.close();
  });

  it("token for alex reads a freshly written email through the API", async () => {
    await ready();
    const m = process.env.ARKIV_TEST_MNEMONIC!;
    const operator = mnemonicToAccount(m, { addressIndex: 3 });
    const owner = mnemonicToAccount(m, { addressIndex: 4 });
    const master = parseMasterKey(randomBytes(32).toString("hex"));

    const seeded = await seedDemo(handle.db);
    userId = seeded.userId;
    const [u] = await handle.client`select wallet_address from users where id = ${seeded.userId}`;
    originalWallet = u!.wallet_address as string;
    await handle.client`update users set wallet_address = ${owner.address.toLowerCase()} where id = ${seeded.userId}`;
    // the inbound pipeline also needs the user's public key
    const uk = await generateUserKeypair();
    const ph = Buffer.from("dev-placeholder");
    await handle.db
      .insert(userKeys)
      .values({ userId: seeded.userId, publicKey: Buffer.from(uk.publicKey), keyId: keyId(uk.publicKey), wrappedPrivateKeyWallet: ph, wrappedPrivateKeyRecovery: ph, wrappedSeedWallet: ph, wrappedSeedRecovery: ph, walletSalt: ph, recoverySalt: ph })
      .onConflictDoUpdate({ target: userKeys.userId, set: { publicKey: Buffer.from(uk.publicKey), keyId: keyId(uk.publicKey) } });
    void eq;

    // 1. provision alex's key + token FIRST, 2. then the email arrives
    await provisionNaniteAgentKey(handle.db, seeded.agentId, master);
    const { token } = await issueAgentToken(handle.db, seeded.agentId, { label: "live-check" });

    const real = createRealArkivWriter({
      privateKey: bytesToHex(operator.getHdKey().privateKey!) as Hex,
      accessKey: process.env.ARKIV_ACCESS_KEY ?? "",
    });
    const emailId = `em_agentlive_${tag}`;
    const provider = createFakeMailProvider({
      webhookSecret: SECRET,
      emails: { [emailId]: { subject: SUBJECT, text: BODY, from: "FAKE <fake.sender@example.com>" } },
    });
    const app = createApp({
      db: { ping: async () => void (await handle.client`select 1`) },
      webOrigin: "http://localhost:3000",
      version: "live",
      log: () => undefined,
      inbound: { db: handle.db, provider, arkiv: real.port, senderHashSecret: "live-sender-hash-secret-0123456789" },
      v1: { db: handle.db, reader: real.reader, masterKey: master },
    });

    const body = JSON.stringify({
      type: "email.received",
      created_at: new Date().toISOString(),
      data: { email_id: emailId, from: "FAKE <fake.sender@example.com>", to: ["alex@nanite.test"], bcc: [], cc: [], received_for: ["alex@nanite.test"], message_id: "<live@example.com>", subject: SUBJECT, attachments: [] },
    });
    const id = `msg_agentlive_${tag}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const wh = await app.request("/webhooks/resend", {
      method: "POST",
      headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": signSvix(SECRET, id, ts, body) },
      body,
    });
    expect(wh.status).toBe(200);
    const [ev] = await handle.client`select arkiv_entity_key from webhook_events where provider_event_id = ${id}`;
    const entityKey = ev!.arkiv_entity_key as Hex;
    expect(entityKey).toMatch(/^0x[0-9a-f]{64}$/);
    await real.reader.waitForQueryable(entityKey, { timeoutMs: 45_000, intervalMs: 1500 });

    const auth = { authorization: `Bearer ${token}` };
    const inbox = await app.request("/v1/inbox?limit=10", { headers: auth });
    expect(inbox.status).toBe(200);
    const items = ((await inbox.json()) as { items: { entityKey: string }[] }).items;
    expect(items.map((i) => i.entityKey)).toContain(entityKey);

    const res = await app.request(`/v1/emails/${entityKey}`, { headers: auth });
    expect(res.status).toBe(200);
    const mail = (await res.json()) as { content_trust: string; untrusted: { subject: string; body: string }; links: string[] };
    expect(mail.content_trust).toBe("untrusted");
    expect(mail.untrusted.subject).toBe(SUBJECT);
    expect(mail.untrusted.body).toContain(`FAKE body ${tag}`);
    expect(mail.links).toContain("https://example.com/agent-live");
    expect((await app.request("/v1/inbox", { headers: { authorization: "Bearer nan_" + "z".repeat(43) } })).status).toBe(401);

    appendFileSync(
      REPORT,
      `\n## Agent API run ${new Date().toISOString()} (T3.4)\n\n` +
        `Key for alex provisioned (custody nanite) and token issued BEFORE the email; fake inbound email written through the signed webhook flow with the real writer.\n\n` +
        `| entity key | /v1/inbox | /v1/emails/:key | bad token |\n| --- | --- | --- | --- |\n` +
        `| \`${entityKey}\` | 200, key listed | 200, decrypted (subject/body/links match), content_trust untrusted | 401 |\n`,
    );
  }, 120_000);
});
