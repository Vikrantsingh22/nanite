import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailRecord } from "@nanite/arkiv";
import { generateUserKeypair, keyId, ready } from "@nanite/crypto";
import { agents, createDb, createSession, users } from "@nanite/db";
import { inArray } from "drizzle-orm";
import { createApp } from "../src/app.js";
import type { MailReader } from "../src/routes/mail.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
const handle = createDb(DATABASE_URL, { max: 3 });
const tag = randomBytes(4).toString("hex");
const hex = (n: number) => randomBytes(n).toString("hex");

class FakeReader implements MailReader {
  records: EmailRecord[] = [];
  lastList: Parameters<MailReader["listInbox"]>[0] | null = null;
  fail = false;
  async listInbox(o: Parameters<MailReader["listInbox"]>[0]) {
    if (this.fail) throw new Error("rpc down");
    this.lastList = o;
    // Like the real reader: honours agentId, owner (the $owner pin), ownerId, types and before.
    let items = this.records.filter((r) => r.agentId === o.agentId);
    if (o.owner) items = items.filter((r) => r.$owner.toLowerCase() === o.owner!.toLowerCase());
    if (o.ownerId) items = items.filter((r) => r.ownerId.toLowerCase() === o.ownerId!.toLowerCase());
    if (o.types?.length) items = items.filter((r) => o.types!.includes(r.type));
    if (o.before !== undefined) items = items.filter((r) => r.receivedAt < o.before!);
    items = items.sort((a, b) => b.receivedAt - a.receivedAt).slice(0, o.limit ?? 25);
    return { items, skipped: 0 };
  }
  async getEmail(k: `0x${string}`) {
    return this.records.find((r) => r.$key === k) ?? null;
  }
}

const reader = new FakeReader();
const userIds: string[] = [];
interface U {
  id: string;
  wallet: string;
  cookie: string;
  agentId: string;
  ens: string;
}
let A: U;
let B: U;

async function makeUser(label: string): Promise<U> {
  const wallet = "0x" + hex(20);
  const [row] = await handle.db.insert(users).values({ walletAddress: wallet, username: `t33${label}${tag}` }).returning({ id: users.id });
  userIds.push(row!.id);
  const kp = await generateUserKeypair();
  const agentId = crypto.randomUUID();
  const ens = `${label}${tag}.t33.nanitecom.eth`;
  await handle.db.insert(agents).values({
    id: agentId,
    userId: row!.id,
    name: `${label}${tag}`,
    derivationIndex: 0,
    walletAddress: "0x" + hex(20),
    ensName: ens,
    publicKey: Buffer.from(kp.publicKey),
    keyId: keyId(kp.publicKey),
    custody: "self",
  });
  const session = await createSession(handle.db, row!.id, new Date(Date.now() + 3600_000));
  return { id: row!.id, wallet, cookie: `nanite_session=${session.id}`, agentId, ens };
}

function rec(owner: U, over: Partial<EmailRecord> = {}): EmailRecord {
  return {
    $key: `0x${hex(32)}`,
    $owner: owner.wallet as `0x${string}`,
    $creator: "0x0000000000000000000000000000000000000002",
    $expiresAt: 1_000_100n,
    agentId: owner.ens,
    ownerId: owner.wallet as `0x${string}`,
    type: "conversation",
    receivedAt: 1000,
    threadId: "t".repeat(32),
    senderHash: "a".repeat(64),
    keyIds: ["0123456789abcdef"],
    ciphertext: Uint8Array.of(1, 2, 3),
    wrappedKeys: Uint8Array.of(4, 5),
    nonce: Uint8Array.of(6),
    ...over,
  };
}

const app = createApp({
  db: { ping: async () => void (await handle.client`select 1`) },
  webOrigin: "http://localhost:3000",
  version: "t",
  log: () => undefined,
  auth: { db: handle.db, chainIds: [11155111], secureCookie: false },
  mail: { reader, blockNumber: async () => 1_000_000n, now: () => new Date("2026-01-01T00:00:00Z") },
});
const get = (path: string, u?: U) => app.request(path, { headers: u ? { cookie: u.cookie } : {} });

beforeAll(async () => {
  await ready();
  A = await makeUser("a");
  B = await makeUser("b");
});
afterAll(async () => {
  await handle.db.delete(users).where(inArray(users.id, userIds));
  await handle.close();
});

describe("GET /mail/:agentId/inbox", () => {
  it("requires a session", async () => {
    expect((await get(`/mail/${A.agentId}/inbox`)).status).toBe(401);
  });

  it("returns the user's encrypted entities as base64 with the owner pin applied", async () => {
    const r1 = rec(A, { receivedAt: 2000, type: "otp" });
    const r2 = rec(A, { receivedAt: 3000 });
    reader.records.push(r1, r2, rec(B, { receivedAt: 4000 }));
    const res = await get(`/mail/${A.agentId}/inbox`, A);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { items: Record<string, any>[] };
    expect(body.items.map((i) => i.key)).toEqual([r2.$key, r1.$key]);
    expect(body.items[0]).toMatchObject({
      type: "conversation",
      receivedAt: 3000,
      ciphertext: Buffer.from([1, 2, 3]).toString("base64"),
      wrappedKeys: Buffer.from([4, 5]).toString("base64"),
      nonce: Buffer.from([6]).toString("base64"),
      expiresAtBlock: "1000100",
      expiresAt: new Date(Date.parse("2026-01-01T00:00:00Z") + 100 * 2000).toISOString(),
    });
    // The reader was asked for this agent, pinned to the user's wallet as ownerId AND $owner.
    expect(reader.lastList).toMatchObject({ agentId: A.ens, ownerId: A.wallet, owner: A.wallet });
  });

  it("drops entities that are not owned by the user even if the reader returned them", async () => {
    const stolen = rec(A, { $owner: B.wallet as `0x${string}`, receivedAt: 5000 });
    const foreignAgent = rec(A, { agentId: B.ens, receivedAt: 5001 });
    const orig = reader.listInbox.bind(reader);
    reader.listInbox = async () => ({ items: [stolen, foreignAgent], skipped: 0 });
    try {
      const body = (await (await get(`/mail/${A.agentId}/inbox`, A)).json()) as { items: unknown[] };
      expect(body.items).toEqual([]);
    } finally {
      reader.listInbox = orig;
    }
  });

  it("filters by type, before and limit, and pages with nextBefore", async () => {
    const body = (await (await get(`/mail/${A.agentId}/inbox?type=otp`, A)).json()) as { items: { type: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.type === "otp")).toBe(true);
    const page = (await (await get(`/mail/${A.agentId}/inbox?limit=1`, A)).json()) as { items: { receivedAt: number }[]; nextBefore?: number };
    expect(page.items).toHaveLength(1);
    expect(page.nextBefore).toBe(page.items[0]!.receivedAt);
    const next = (await (await get(`/mail/${A.agentId}/inbox?limit=1&before=${page.nextBefore}`, A)).json()) as { items: { receivedAt: number }[] };
    expect(next.items[0]!.receivedAt).toBeLessThan(page.nextBefore!);
  });

  it("rejects bad query params with 400", async () => {
    for (const q of ["type=bogus", "limit=0", "limit=101", "limit=abc", "before=-1"]) {
      expect((await get(`/mail/${A.agentId}/inbox?${q}`, A)).status).toBe(400);
    }
  });

  it("404 for another user's agent, an unknown agent and a malformed id", async () => {
    expect((await get(`/mail/${B.agentId}/inbox`, A)).status).toBe(404);
    expect((await get(`/mail/${crypto.randomUUID()}/inbox`, A)).status).toBe(404);
    expect((await get(`/mail/not-a-uuid/inbox`, A)).status).toBe(404);
  });

  it("502 with a fixed code when Arkiv is unreachable (no error text)", async () => {
    reader.fail = true;
    try {
      const res = await get(`/mail/${A.agentId}/inbox`, A);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "upstream_unavailable" });
    } finally {
      reader.fail = false;
    }
  });
});

describe("GET /mail/:agentId/emails/:key", () => {
  it("returns one entity of the user's own agent", async () => {
    const r = rec(A, { receivedAt: 6000 });
    reader.records.push(r);
    const res = await get(`/mail/${A.agentId}/emails/${r.$key}`, A);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { key: string }).key).toBe(r.$key);
  });

  it("404 for another user's entity, for the same entity under the wrong agent, and for unknown or malformed keys", async () => {
    const mine = rec(A);
    const theirs = rec(B);
    reader.records.push(mine, theirs);
    expect((await get(`/mail/${A.agentId}/emails/${theirs.$key}`, A)).status).toBe(404);
    expect((await get(`/mail/${B.agentId}/emails/${mine.$key}`, A)).status).toBe(404);
    expect((await get(`/mail/${B.agentId}/emails/${theirs.$key}`, A)).status).toBe(404);
    expect((await get(`/mail/${A.agentId}/emails/0x${hex(32)}`, A)).status).toBe(404);
    expect((await get(`/mail/${A.agentId}/emails/nope`, A)).status).toBe(404);
  });

  it("404 when the entity is owned by someone else (transferred look-alike) and 401 without a session", async () => {
    const transferred = rec(A, { $owner: B.wallet as `0x${string}` });
    reader.records.push(transferred);
    expect((await get(`/mail/${A.agentId}/emails/${transferred.$key}`, A)).status).toBe(404);
    expect((await get(`/mail/${A.agentId}/emails/${transferred.$key}`)).status).toBe(401);
  });
});
