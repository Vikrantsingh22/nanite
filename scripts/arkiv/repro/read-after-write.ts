// Read-after-write lag on the public RPC: create a tiny entity (test wallet index 1, 60 s lifetime), then poll every 100 ms
// from the moment createEntity returns (the SDK has already waited for the receipt) until getEntity and arkiv_query see it.
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/read-after-write.ts [runs]
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { bytes, defineSchema, str } from "@arkiv-network/sdk/schema";
import { http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { rpc } from "./lib";

const runs = Number(process.argv[2] ?? 3);
const chain = rabdi({ accessKey: "" });
const pub = createPublicClient({ chain, transport: http() }) as any;
const mnemonic = process.env.ARKIV_TEST_MNEMONIC;
if (!mnemonic) throw new Error("ARKIV_TEST_MNEMONIC missing (.env)");
const account = mnemonicToAccount(mnemonic, { addressIndex: 1 });
const wallet = createWalletClient({ chain, transport: http(), account }) as any;
const S = defineSchema("nanite.repro.raw.v1", { tag: str().indexed(), body: bytes() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`# read-after-write ${new Date().toISOString()}`);
for (let i = 0; i < runs; i++) {
  const r = await wallet.createEntity(S, { tag: `raw-${Date.now()}`, body: new Uint8Array(8) }, { expiration: ExpirationTime.fromSeconds(60) });
  const t0 = Date.now();
  let viaGet: number | null = null;
  let viaQuery: number | null = null;
  let getMisses = 0;
  while ((viaGet === null || viaQuery === null) && Date.now() - t0 < 20_000) {
    if (viaGet === null) {
      try {
        await pub.getEntity(r.entityKey);
        viaGet = Date.now() - t0;
      } catch {
        getMisses++;
      }
    }
    if (viaQuery === null) {
      const q = await rpc("arkiv_query", [`$key = key(${r.entityKey})`, { select: { key: true }, limit: "0x1" }]);
      if (q.body.result?.data?.length) viaQuery = Date.now() - t0;
    }
    await sleep(100);
  }
  console.log(`run ${i + 1}: tx=${r.txHash} getEntity visible after ${viaGet}ms (${getMisses} misses), arkiv_query visible after ${viaQuery}ms`);
}
