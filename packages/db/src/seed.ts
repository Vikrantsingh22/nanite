import { and, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { agents, domains, mailboxes, users } from "./schema.js";

export interface SeedOptions {
  sharedDomain?: string;
}

/** Idempotent demo seed: one user, one shared domain, one agent, one mailbox. */
export async function seedDemo(db: Db, options: SeedOptions = {}) {
  const domainName = (options.sharedDomain ?? "nanite.test").toLowerCase();

  await db
    .insert(users)
    .values({
      walletAddress: "0xfad31e74f1cb69046bbb2e4a15ce653bee6936c0",
      username: "vikrant",
      ensName: "vikrant.nanitecom.eth",
      onboardingState: "done",
    })
    .onConflictDoNothing({ target: users.username });
  const [user] = await db.select().from(users).where(eq(users.username, "vikrant"));
  if (!user) throw new Error("seed: user missing");

  await db
    .insert(domains)
    .values({ ownerUserId: null, name: domainName, status: "verified" })
    .onConflictDoNothing({ target: domains.name });
  const [domain] = await db.select().from(domains).where(eq(domains.name, domainName));
  if (!domain) throw new Error("seed: domain missing");

  await db
    .insert(agents)
    .values({
      userId: user.id,
      name: "alex",
      derivationIndex: 0,
      walletAddress: "0xc0575045b1acacc1349e3e5f8be20fba3a8e287b",
      ensName: "alex.vikrant.nanitecom.eth",
      publicKey: Buffer.alloc(32, 1), // placeholder, not a real key
      keyId: "demo-alex-key-1",
      custody: "nanite",
    })
    .onConflictDoNothing({ target: agents.ensName });
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, user.id), eq(agents.derivationIndex, 0)));
  if (!agent) throw new Error("seed: agent missing");

  await db
    .insert(mailboxes)
    .values({
      address: `alex@${domainName}`,
      domainId: domain.id,
      userId: user.id,
      agentId: agent.id,
    })
    .onConflictDoNothing({ target: mailboxes.address });

  return { userId: user.id, domainId: domain.id, agentId: agent.id, mailbox: `alex@${domainName}` };
}
