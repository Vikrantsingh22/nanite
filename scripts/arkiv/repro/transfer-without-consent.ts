// Can a third party push an entity to a victim's wallet without the victim signing? This is why Nanite pins `$creator`,
// not only `$owner`. Attacker = test wallet 7, "victim" = wallet 4 (address only; it never signs). One small write (60 s lifetime).
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/transfer-without-consent.ts
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { bytes, defineSchema, str } from "@arkiv-network/sdk/schema";
import { http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { rpc } from "./lib";

const chain = rabdi({ accessKey: "" });
const pub = createPublicClient({ chain, transport: http() }) as any;
const mnemonic = process.env.ARKIV_TEST_MNEMONIC;
if (!mnemonic) throw new Error("ARKIV_TEST_MNEMONIC missing (.env)");
const attacker = mnemonicToAccount(mnemonic, { addressIndex: 7 });
const victim = mnemonicToAccount(mnemonic, { addressIndex: 4 }).address;
const wallet = createWalletClient({ chain, transport: http(), account: attacker }) as any;
const S = defineSchema("nanite.repro.gift.v1", { tag: str().indexed(), body: bytes() });

const [pred] = await pub.predictEntityKeys({ owner: attacker.address, count: 1 });
const r = await wallet.executeBatch({
  creates: [{ schema: S, values: { tag: "gift", body: new Uint8Array(4) }, expiration: ExpirationTime.fromSeconds(120), salt: pred.salt }],
  ownershipChanges: [{ entityKey: pred.key, newOwner: victim }],
});
console.log(`# transfer without consent ${new Date().toISOString()}\nattacker ${attacker.address} created ${pred.key} and gave it to ${victim} in tx ${r.txHash}`);
await new Promise((x) => setTimeout(x, 3000));
const q = await rpc("arkiv_query", [`arkiv.schema = str('nanite.repro.gift.v1') AND $owner = addr(${victim})`, { select: { key: true, owner: true, creator: true }, limit: "0x5" }]);
console.log(`query $owner = victim -> ${JSON.stringify(q.body.result?.data ?? q.body.error)}`);

// Bonus: composite ORDER BY (the docs show a single key).
const o = await rpc("arkiv_query", [`arkiv.schema = str('nanite.email.v1') ORDER BY type:str ASC, receivedAt:u64 DESC`, { select: { key: true }, limit: "0x1" }]);
console.log(`ORDER BY two keys -> ${JSON.stringify(o.body.error ?? "accepted")}`);
