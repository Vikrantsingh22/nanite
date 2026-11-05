import { and, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { agents, mailboxes, userKeys, users, webhookEvents } from "./schema.js";

/**
 * Hot inbound lookup: routing for a recipient address. Case-insensitive.
 * Returns the user, agent and key ids needed to encrypt and store the email,
 * or null if the address is unknown. The caller must check mailbox status and
 * agent revocation (both are returned).
 */
export async function findMailboxByAddress(db: Db, address: string) {
  const rows = await db
    .select({
      mailboxId: mailboxes.id,
      address: mailboxes.address,
      mailboxStatus: mailboxes.status,
      domainId: mailboxes.domainId,
      userId: users.id,
      username: users.username,
      userWalletAddress: users.walletAddress,
      userKeyId: userKeys.keyId,
      agentId: agents.id,
      agentName: agents.name,
      agentEnsName: agents.ensName,
      agentKeyId: agents.keyId,
      agentRevokedAt: agents.revokedAt,
    })
    .from(mailboxes)
    .innerJoin(users, eq(users.id, mailboxes.userId))
    .innerJoin(agents, eq(agents.id, mailboxes.agentId))
    .leftJoin(userKeys, eq(userKeys.userId, users.id))
    .where(eq(mailboxes.address, address.trim().toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

export interface RecordWebhookEventInput {
  provider: string;
  providerEventId: string;
  resendEmailId?: string | null;
}

/**
 * Insert-or-get for webhook dedupe. `created` is true only for the first delivery;
 * a duplicate returns the existing row with `created: false`.
 */
export async function recordWebhookEvent(db: Db, input: RecordWebhookEventInput) {
  const inserted = await db
    .insert(webhookEvents)
    .values({
      provider: input.provider,
      providerEventId: input.providerEventId,
      resendEmailId: input.resendEmailId ?? null,
    })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.providerEventId] })
    .returning();
  if (inserted[0]) return { event: inserted[0], created: true as const };
  const existing = await db
    .select()
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.provider, input.provider),
        eq(webhookEvents.providerEventId, input.providerEventId),
      ),
    )
    .limit(1);
  const event = existing[0];
  if (!event) throw new Error("webhook_events row vanished after conflict");
  return { event, created: false as const };
}
