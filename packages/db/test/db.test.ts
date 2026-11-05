import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { count, eq, sql } from "drizzle-orm";
import {
  agents,
  arkivWrites,
  createDb,
  domains,
  findMailboxByAddress,
  mailboxes,
  recordWebhookEvent,
  runMigrations,
  seedDemo,
  users,
  webhookEvents,
  type DbHandle,
} from "../src/index.js";

let h: DbHandle;

const WALLET = "0x1111111111111111111111111111111111111111";

beforeAll(async () => {
  h = createDb(process.env.TEST_DATABASE_URL!, { max: 2 });
  // Empty database: drop everything, then migrate from scratch.
  await h.client.unsafe("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  await runMigrations(h.db);
});

afterAll(async () => {
  await h.close();
});

describe("migrations", () => {
  it("create all tables on an empty database", async () => {
    const rows = await h.client`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    const names = rows.map((r) => r.table_name as string);
    for (const t of [
      "users", "user_keys", "domains", "agents", "mailboxes", "api_tokens",
      "webhook_events", "arkiv_writes", "send_log", "auth_nonces", "sessions", "audit_log",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("are re-runnable", async () => {
    await runMigrations(h.db);
  });
});

describe("seed", () => {
  it("is idempotent", async () => {
    await seedDemo(h.db, { sharedDomain: "nanite.test" });
    await seedDemo(h.db, { sharedDomain: "nanite.test" });
    for (const t of [users, domains, agents, mailboxes]) {
      const [r] = await h.db.select({ n: count() }).from(t);
      expect(r?.n).toBe(1);
    }
  });
});

describe("constraints", () => {
  it("rejects custody=self with an encrypted private key", async () => {
    const [u] = await h.db.select().from(users);
    await expect(
      h.db.insert(agents).values({
        userId: u!.id,
        name: "selfy",
        derivationIndex: 5,
        walletAddress: "0x2222222222222222222222222222222222222222",
        ensName: "selfy.vikrant.nanitecom.eth",
        publicKey: Buffer.alloc(32, 2),
        keyId: "k",
        custody: "self",
        encryptedPrivateKey: Buffer.alloc(8, 3),
      }),
    ).rejects.toThrow();
    // self custody without a key is fine
    await h.db.insert(agents).values({
      userId: u!.id,
      name: "selfy",
      derivationIndex: 5,
      walletAddress: "0x2222222222222222222222222222222222222222",
      ensName: "selfy.vikrant.nanitecom.eth",
      publicKey: Buffer.alloc(32, 2),
      keyId: "k",
      custody: "self",
    });
  });

  it("rejects an uppercase wallet address", async () => {
    await expect(
      h.db.insert(users).values({ walletAddress: WALLET.replace("1", "A").replace("0x", "0x"), username: "upper" }),
    ).rejects.toThrow();
    await expect(
      h.db.insert(users).values({ walletAddress: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD", username: "upper2" }),
    ).rejects.toThrow();
  });

  it("rejects a username that is not ENS-label-safe", async () => {
    await expect(
      h.db.insert(users).values({ walletAddress: WALLET, username: "Bad_Name" }),
    ).rejects.toThrow();
  });

  it("rejects a duplicate provider event, and recordWebhookEvent dedupes", async () => {
    await h.db.insert(webhookEvents).values({ provider: "resend", providerEventId: "evt_1" });
    await expect(
      h.db.insert(webhookEvents).values({ provider: "resend", providerEventId: "evt_1" }),
    ).rejects.toThrow();

    const first = await recordWebhookEvent(h.db, { provider: "resend", providerEventId: "evt_2", resendEmailId: "em_1" });
    const second = await recordWebhookEvent(h.db, { provider: "resend", providerEventId: "evt_2", resendEmailId: "em_1" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    // same id under another provider is a different event
    const other = await recordWebhookEvent(h.db, { provider: "other", providerEventId: "evt_2" });
    expect(other.created).toBe(true);
  });

  it("rejects a non-lowercase mailbox address", async () => {
    const [u] = await h.db.select().from(users);
    const [a] = await h.db.select().from(agents);
    const [d] = await h.db.select().from(domains);
    await expect(
      h.db.insert(mailboxes).values({ address: "Bob@nanite.test", domainId: d!.id, userId: u!.id, agentId: a!.id }),
    ).rejects.toThrow();
  });
});

describe("arkiv_writes idempotency", () => {
  it("allows one row per (webhook event, mailbox) and rejects a duplicate", async () => {
    const [mb] = await h.db.select().from(mailboxes).limit(1);
    const { event } = await recordWebhookEvent(h.db, { provider: "resend", providerEventId: "evt_aw_1" });
    await h.db.insert(arkivWrites).values({ kind: "email", webhookEventId: event.id, mailboxId: mb!.id, status: "submitted" });
    await expect(
      h.db.insert(arkivWrites).values({ kind: "email", webhookEventId: event.id, mailboxId: mb!.id }),
    ).rejects.toThrow();
    // another event for the same mailbox is fine
    const { event: e2 } = await recordWebhookEvent(h.db, { provider: "resend", providerEventId: "evt_aw_2" });
    await h.db.insert(arkivWrites).values({ kind: "email", webhookEventId: e2.id, mailboxId: mb!.id });
  });

  it("does not constrain non-inbound rows (null event/mailbox) and cascades on event delete", async () => {
    await h.db.insert(arkivWrites).values({ kind: "extend" });
    await h.db.insert(arkivWrites).values({ kind: "extend" });
    const { event } = await recordWebhookEvent(h.db, { provider: "resend", providerEventId: "evt_aw_3" });
    const [mb] = await h.db.select().from(mailboxes).limit(1);
    await h.db.insert(arkivWrites).values({ kind: "email", webhookEventId: event.id, mailboxId: mb!.id });
    await h.db.delete(webhookEvents).where(eq(webhookEvents.id, event.id));
    const left = await h.db.select().from(arkivWrites).where(eq(arkivWrites.webhookEventId, event.id));
    expect(left).toHaveLength(0);
  });
});

describe("findMailboxByAddress", () => {
  it("is case-insensitive and returns routing ids", async () => {
    const lower = await findMailboxByAddress(h.db, "alex@nanite.test");
    const mixed = await findMailboxByAddress(h.db, "  Alex@NANITE.test ");
    expect(lower).not.toBeNull();
    expect(mixed?.mailboxId).toBe(lower?.mailboxId);
    expect(lower?.agentEnsName).toBe("alex.vikrant.nanitecom.eth");
    expect(lower?.mailboxStatus).toBe("active");
    expect(lower?.userId).toBeTruthy();
    expect(lower?.agentKeyId).toBe("demo-alex-key-1");
  });

  it("returns null for an unknown address", async () => {
    expect(await findMailboxByAddress(h.db, "nobody@nanite.test")).toBeNull();
  });

  it("uses the unique address index", async () => {
    const rows = await h.client`SELECT indexname FROM pg_indexes WHERE tablename = 'mailboxes' AND indexname = 'mailboxes_address_unique'`;
    expect(rows.length).toBe(1);
    void sql;
  });
});
