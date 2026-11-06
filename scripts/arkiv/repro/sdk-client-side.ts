// Client-side SDK 1.0.1 behaviours (no transaction is sent; reads are read-only).
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/sdk-client-side.ts
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { addr, bytes, defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
import { http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const attempt = async (label: string, fn: () => unknown) => {
  try {
    const r = await fn();
    console.log(`${label}\n   -> OK ${typeof r === "object" ? JSON.stringify(r, (_, v) => (typeof v === "bigint" ? `${v}n` : v)).slice(0, 300) : String(r)}`);
  } catch (e) {
    console.log(`${label}\n   -> THROWS ${(e as Error).name}: ${String((e as Error).message).replace(/\s+/g, " ").slice(0, 300)}`);
  }
};

console.log(`# SDK client-side checks ${new Date().toISOString()}`);

// (A numeric `flags` value is rejected by TypeScript: see flags-typecheck.ts.)

// 2. rabdi() with no argument.
await attempt("rabdi() with no argument", () => (rabdi as any)());
await attempt('rabdi({ accessKey: "" })', () => rabdi({ accessKey: "" }).id);

// 3. executeBatch create item with a nested `options` object (a plausible but wrong shape).
const Schema = defineSchema("repro.v1", { who: addr().indexed(), n: u64().indexed(), body: bytes() });
const account = privateKeyToAccount(generatePrivateKey()); // throw-away, unfunded, never used for a tx
const wallet = createWalletClient({ chain: rabdi({ accessKey: "" }), transport: http(), account }) as any;
await attempt("executeBatch({ creates: [{ schema, values, options: { expiration } }] })  [wrong shape]", () =>
  wallet.executeBatch({
    creates: [{ schema: Schema, values: { who: addr(account.address), n: u64(1n), body: new Uint8Array(1) }, options: { expiration: ExpirationTime.fromSeconds(60) } }],
  }),
);

// 4. read-side shapes on a real entity (read-only).
const pub = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http() }) as any;
const key = "0xd694db84e709e1960d5559b8cd0d5610e4e6532f3e79145b561cf2f35c96658f";
const Email = defineSchema("nanite.email.v1", { agentId: str().indexed(), ciphertext: bytes() });
await attempt("getEntity(key, schema): field shapes", async () => {
  const e = await pub.getEntity(key, Email);
  return { keys: Object.keys(e), ciphertextShape: Object.keys(e.ciphertext ?? {}), agentIdType: typeof e.agentId };
});
await attempt("select().from(schema) page: type of `skipped`", async () => {
  const page = await pub.select({ agentId: true }).from(Email).createdBy("0xA7B7EbE69F1bcb3ACD680d5e06cE640E0D2D247F").limit(1).fetch();
  return { skippedType: typeof page.skipped, skipped: page.skipped };
});
