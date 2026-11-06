// Create + changeOwnership in one batch needs predictEntityKeys, which depends on the sender's next nonce.
// Two concurrent batches from one sender, both using the same prediction. Writes (tiny, 60 s entities) from test wallet index 1.
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/nonce-race.ts
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { bytes, defineSchema, str } from "@arkiv-network/sdk/schema";
import { http } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const chain = rabdi({ accessKey: "" });
const pub = createPublicClient({ chain, transport: http() }) as any;
const mnemonic = process.env.ARKIV_TEST_MNEMONIC;
if (!mnemonic) throw new Error("ARKIV_TEST_MNEMONIC missing (.env)");
const sender = mnemonicToAccount(mnemonic, { addressIndex: 1 });
const user = mnemonicToAccount(mnemonic, { addressIndex: 4 }).address; // spike "user" wallet, receives ownership
const wallet = createWalletClient({ chain, transport: http(), account: sender }) as any;
const S = defineSchema("nanite.repro.race.v1", { tag: str().indexed(), body: bytes() });

const [pred] = await pub.predictEntityKeys({ owner: sender.address, count: 1 });
console.log(`# nonce race ${new Date().toISOString()}\nsender ${sender.address}, same prediction for both batches: ${pred.key}`);
const bal0 = await pub.getBalance({ address: sender.address });

const send = (label: string) =>
  wallet
    .executeBatch({
      creates: [{ schema: S, values: { tag: label, body: new Uint8Array(8) }, expiration: ExpirationTime.fromSeconds(60), salt: pred.salt }],
      ownershipChanges: [{ entityKey: pred.key, newOwner: user }],
    })
    .then((r: any) => `${label}: LANDED tx=${r.txHash} created=${r.createdEntities?.[0]}`)
    .catch((e: any) => `${label}: FAILED ${e.name}: ${String(e.message).replace(/\s+/g, " ").slice(0, 200)} txHash=${e.txHash ?? "(none)"}`);

const results = await Promise.all([send("batch-A"), send("batch-B")]);
for (const r of results) console.log(r);
const bal1 = await pub.getBalance({ address: sender.address });
console.log(`balance change = ${bal1 - bal0} wei`);
