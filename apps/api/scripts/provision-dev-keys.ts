/*
 * DEV/TEST ONLY. Gives the seeded demo user (vikrant) and agent (alex) real X25519 public keys so the
 * inbound pipeline can encrypt to them. Private keys are returned to the caller and never stored;
 * wrapped_* columns get placeholder bytes (not real ciphertext). Overwrites the seed's placeholder keys.
 *
 *   docker compose run --rm tools npx tsx apps/api/scripts/provision-dev-keys.ts
 */
import { pathToFileURL } from "node:url";
import { generateUserKeypair, keyId, type Keypair } from "@nanite/crypto";
import { agents, createDb, seedDemo, userKeys, type Db } from "@nanite/db";
import { and, eq } from "drizzle-orm";

export interface DevKeys {
  userId: string;
  agentId: string;
  mailbox: string;
  user: Keypair & { keyId: string };
  agent: Keypair & { keyId: string };
}

export async function provisionDevKeys(db: Db): Promise<DevKeys> {
  const seeded = await seedDemo(db);
  const user = await generateUserKeypair();
  const agent = await generateUserKeypair();
  const userKeyId = keyId(user.publicKey);
  const agentKeyId = keyId(agent.publicKey);
  const placeholder = Buffer.from("dev-placeholder");

  await db
    .insert(userKeys)
    .values({
      userId: seeded.userId,
      publicKey: Buffer.from(user.publicKey),
      keyId: userKeyId,
      wrappedPrivateKeyWallet: placeholder,
      wrappedPrivateKeyRecovery: placeholder,
      wrappedSeedWallet: placeholder,
      wrappedSeedRecovery: placeholder,
      walletSalt: placeholder,
      recoverySalt: placeholder,
    })
    .onConflictDoUpdate({
      target: userKeys.userId,
      set: { publicKey: Buffer.from(user.publicKey), keyId: userKeyId },
    });
  await db
    .update(agents)
    .set({ publicKey: Buffer.from(agent.publicKey), keyId: agentKeyId })
    .where(and(eq(agents.userId, seeded.userId), eq(agents.derivationIndex, 0)));

  return {
    userId: seeded.userId,
    agentId: seeded.agentId,
    mailbox: seeded.mailbox,
    user: { ...user, keyId: userKeyId },
    agent: { ...agent, keyId: agentKeyId },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = createDb(process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite", { max: 1 });
  const keys = await provisionDevKeys(handle.db);
  console.log(`provisioned dev public keys for ${keys.mailbox} (user ${keys.user.keyId}, agent ${keys.agent.keyId})`);
  await handle.close();
}
