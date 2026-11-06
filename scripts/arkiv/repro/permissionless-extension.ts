// Ownership and extension by a third party. Creator = test wallet 1, new owner = wallet 4 (address only, never signs),
// stranger = wallet 7. Two entities created and transferred in one batch each: with and without { permissionlessExtension: true }.
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/permissionless-extension.ts
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { bytes, defineSchema, str } from "@arkiv-network/sdk/schema";
import { http, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const chain = rabdi({ accessKey: "" });
const pub = createPublicClient({ chain, transport: http() }) as any;
const mnemonic = process.env.ARKIV_TEST_MNEMONIC;
if (!mnemonic) throw new Error("ARKIV_TEST_MNEMONIC missing (.env)");
const creator = mnemonicToAccount(mnemonic, { addressIndex: 1 });
const newOwner = mnemonicToAccount(mnemonic, { addressIndex: 4 }).address;
const stranger = mnemonicToAccount(mnemonic, { addressIndex: 7 });
const cw = createWalletClient({ chain, transport: http(), account: creator }) as any;
const sw = createWalletClient({ chain, transport: http(), account: stranger }) as any;
const S = defineSchema("nanite.repro.ext.v1", { tag: str().indexed(), body: bytes() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: any) => `${e.name}: ${String(e.message).replace(/\s+/g, " ").slice(0, 170)}`;

async function make(label: string, flags?: { permissionlessExtension: true }): Promise<Hex> {
  const [pred] = await pub.predictEntityKeys({ owner: creator.address, count: 1 });
  const r = await cw.executeBatch({
    creates: [{ schema: S, values: { tag: label, body: new Uint8Array(8) }, expiration: ExpirationTime.fromSeconds(300), salt: pred.salt, ...(flags ? { flags } : {}) }],
    ownershipChanges: [{ entityKey: pred.key, newOwner }],
  });
  console.log(`${label}: created+transferred tx=${r.txHash} entity=${pred.key}`);
  return pred.key;
}

console.log(`# permissionlessExtension ${new Date().toISOString()}\ncreator ${creator.address}, owner ${newOwner}, stranger ${stranger.address}`);
const withFlag = await make("with-flag", { permissionlessExtension: true });
await sleep(3000);
const noFlag = await make("no-flag");
await sleep(3000);

for (const [label, key] of [["with-flag", withFlag], ["no-flag", noFlag]] as const) {
  const e = await pub.getEntity(key);
  console.log(`\n${label}: $creator=${e.$creator} $owner=${e.$owner} $creationFlags=${JSON.stringify(e.$creationFlags)} $expiresAt=${e.$expiresAt}`);
  try {
    const r = await sw.extendEntity({ entityKey: key, expiration: ExpirationTime.fromSeconds(600) });
    console.log(`  stranger extendEntity: OK tx=${r.txHash} new expiresAt=${r.expiresAt}`);
  } catch (err) { console.log(`  stranger extendEntity: ${msg(err)}`); }
  try {
    await sw.deleteEntity({ entityKey: key });
    console.log("  stranger deleteEntity: OK (unexpected)");
  } catch (err) { console.log(`  stranger deleteEntity: ${msg(err)}`); }
  try {
    await cw.deleteEntity({ entityKey: key });
    console.log("  original creator deleteEntity after transfer: OK (unexpected)");
  } catch (err) { console.log(`  original creator deleteEntity after transfer: ${msg(err)}`); }
  try {
    await cw.extendEntity({ entityKey: key, expiration: ExpirationTime.fromSeconds(120) });
    console.log("  creator extend to a shorter time: OK (unexpected)");
  } catch (err) { console.log(`  creator shorten attempt: ${msg(err)}`); }
}
