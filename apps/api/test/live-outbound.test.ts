// Opt-in (LIVE_ENS=1): reads the REAL send policy of alex.t21test.nanitecom.eth from Sepolia (fresh Universal
// Resolver read) and runs the send route against it with the FAKE mail provider. No real email is sent.
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateUserKeypair, keyId, ready } from "@nanite/crypto";
import { agents, createDb, userKeys, users } from "@nanite/db";
import { createEnsServiceFromConfig, loadEnsConfig } from "@nanite/ens";
import { eq } from "drizzle-orm";
import { InMemoryArkivWriter } from "../src/arkiv/port.js";
import { createApp } from "../src/app.js";
import { issueAgentToken } from "../src/agent-api/tokens.js";
import { createFakeMailProvider } from "../src/mail/fake.js";

const LIVE = process.env.LIVE_ENS === "1";
const ENS_NAME = "alex.t21test.nanitecom.eth";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";

describe.skipIf(!LIVE)("live: outbound send against the real ENS policy", () => {
  const handle = createDb(DATABASE_URL, { max: 2 });
  let userId = "";
  let agentId = "";
  let token = "";
  const provider = createFakeMailProvider({ webhookSecret: "whsec_" + Buffer.from("x".repeat(24)).toString("base64") });
  const ens = createEnsServiceFromConfig(
    loadEnsConfig({
      OPERATOR_PRIVATE_KEY: `0x${"11".repeat(32)}`, // read-only, never signs
      SEPOLIA_RPC_URL: process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
    }),
  );

  beforeAll(async () => {
    await ready();
    await handle.db.delete(agents).where(eq(agents.ensName, ENS_NAME)); // leftover from a crashed run
    const [u] = await handle.db.insert(users).values({ walletAddress: "0x" + randomBytes(20).toString("hex"), username: `live35${randomBytes(3).toString("hex")}` }).returning({ id: users.id });
    userId = u!.id;
    const uk = await generateUserKeypair();
    const ak = await generateUserKeypair();
    const ph = Buffer.from("x");
    await handle.db.insert(userKeys).values({ userId, publicKey: Buffer.from(uk.publicKey), keyId: keyId(uk.publicKey), wrappedPrivateKeyWallet: ph, wrappedPrivateKeyRecovery: ph, wrappedSeedWallet: ph, wrappedSeedRecovery: ph, walletSalt: ph, recoverySalt: ph });
    agentId = crypto.randomUUID();
    await handle.db.insert(agents).values({ id: agentId, userId, name: "alex", derivationIndex: 0, walletAddress: "0x" + randomBytes(20).toString("hex"), ensName: ENS_NAME, publicKey: Buffer.from(ak.publicKey), keyId: keyId(ak.publicKey), custody: "self" });
    token = (await issueAgentToken(handle.db, agentId)).token;
  });
  afterAll(async () => {
    await handle.db.delete(users).where(eq(users.id, userId));
    await handle.close();
  });

  it("allows the allowlisted address and denies a stranger", async () => {
    const policy = await ens.readSendPolicy(ENS_NAME);
    const app = createApp({
      db: { ping: async () => undefined },
      webOrigin: "http://localhost:3000",
      version: "t",
      log: () => undefined,
      v1: {
        db: handle.db,
        reader: { listInbox: async () => ({ items: [], skipped: 0 }), latestOtp: async () => null, getEmail: async () => null } as never,
        outbound: {
          provider,
          reader: { listInbox: async () => ({ items: [] }), getEmail: async () => null },
          arkiv: new InMemoryArkivWriter(),
          ens: { readSendPolicy: (n) => ens.readSendPolicy(n), resolveEmail: async (n) => (await ens.resolveAgent(n)).email },
          senderHashSecret: "live-check-secret-0123456789",
          sharedMailDomain: "mail.nanite.test",
        },
      },
    });
    const post = (to: string) =>
      app.request("/v1/emails/send", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ to, subject: "live check", body: "live check body" }) });
    const ok = await post("friend@example.com");
    const no = await post("stranger@example.com");
    appendFileSync(
      new URL("../LIVE-CHECK.md", import.meta.url),
      `\n## Outbound send run ${new Date().toISOString()} (T3.5, LIVE_ENS=1)\n\n` +
        `Real ENS policy of \`${ENS_NAME}\` (fresh Universal Resolver read): policy=\`${policy.policy}\`, allow=\`${policy.allow.join(",")}\`, limit=${policy.limit}. Fake mail provider, no real email.\n\n` +
        `| recipient | HTTP |\n| --- | --- |\n| friend@example.com | ${ok.status} |\n| stranger@example.com | ${no.status} |\n`,
    );
    expect(policy.policy).toBe("allowlist");
    expect(ok.status).toBe(200);
    expect(no.status).toBe(403);
    expect(provider.sent).toHaveLength(1);
  }, 60_000);
});
