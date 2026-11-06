// Size limit: documented 128 KiB of bytes per create vs what the node accepts. Uses the spike test wallet
// index 1 (never the operator key). Costs about 0.005 tGLM per successful create at 1 gwei.
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/size-limit.ts            # read-only part only
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/size-limit.ts --write 128276   # attempt one create with N ciphertext bytes
import { createPublicClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { addr, bytes, defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
import { EmailSchema } from "../../../packages/arkiv/src/schema";
import { http, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { createWalletClient } from "@arkiv-network/sdk";
import { randomBytes } from "node:crypto";

const chain = rabdi({ accessKey: "" });
const pub = createPublicClient({ chain, transport: http() }) as any;
const rpcUrl = chain.rpcUrls.default.http[0]!;

// Part 1 (read-only): the largest create that landed during the spike (docs/arkiv-spike/results/W1.json).
const landed = "0x6c55c5e24394ee5530886eb699107ce6cddd01135d8ef611547dff7d51aeec4a" as Hex;
const tx = await pub.getTransaction({ hash: landed });
const rc = await pub.getTransactionReceipt({ hash: landed });
console.log(`# size limit ${new Date().toISOString()}`);
console.log(`landed tx ${landed}\n  input bytes = ${(tx.input.length - 2) / 2}, receipt status = ${rc.status}, gasUsed = ${rc.gasUsed}, effectiveGasPrice = ${rc.effectiveGasPrice}`);

// Part 2 (writes, opt-in).
const wi = process.argv.indexOf("--write");
if (wi > 0) {
  const n = Number(process.argv[wi + 1]);
  const mnemonic = process.env.ARKIV_TEST_MNEMONIC;
  if (!mnemonic) throw new Error("ARKIV_TEST_MNEMONIC missing (.env)");
  const account = mnemonicToAccount(mnemonic, { addressIndex: 1 }); // W1 wallet
  const wallet = createWalletClient({ chain, transport: http(), account }) as any;
  // "min" = 1 string column; "email" = the real Nanite shape (7 indexed attributes + 3 bytes columns, as in packages/arkiv).
  const shape = process.argv.includes("--min") ? "min" : "email";
  const S =
    shape === "min"
      ? defineSchema("nanite.repro.size.v1", { agentId: str().indexed(), ciphertext: bytes(), wrappedKeys: bytes(), nonce: bytes() })
      : EmailSchema;
  const values =
    shape === "min"
      ? { agentId: "repro.size", ciphertext: randomBytes(n), wrappedKeys: randomBytes(160), nonce: randomBytes(12) }
      : {
          agentId: "alex.vikrant.nanitecom.eth",
          ownerId: addr(account.address),
          type: "conversation",
          receivedAt: u64(BigInt(Math.floor(Date.now() / 1000))),
          threadId: randomBytes(16).toString("hex"),
          senderHash: randomBytes(32).toString("hex"),
          keyIds: "81e9852699779810,e533beed30c9da1d",
          ciphertext: randomBytes(n),
          wrappedKeys: randomBytes(160),
          nonce: randomBytes(12),
        };
  console.log(`wallet ${account.address}: shape=${shape}, ciphertext=${n} B + wrappedKeys=160 B + nonce=12 B (total ${n + 172}; SDK limit 131072)`);
  const t0 = Date.now();
  const bal0 = await pub.getBalance({ address: account.address });
  try {
    const r = await wallet.createEntity(S, values, { expiration: ExpirationTime.fromSeconds(60) });
    const sent = await pub.getTransaction({ hash: r.txHash });
    console.log(`  LANDED tx=${r.txHash} entity=${r.entityKey} tx input bytes=${(sent.input.length - 2) / 2} in ${Date.now() - t0}ms`);
  } catch (e) {
    const err = e as any;
    console.log(`  FAILED ${err.name}: ${String(err.message).replace(/\s+/g, " ").slice(0, 300)} txHash=${err.txHash ?? "(none: failed before sending)"} in ${Date.now() - t0}ms`);
  }
  const bal1 = await pub.getBalance({ address: account.address });
  console.log(`  balance change = ${bal1 - bal0} wei (negative = gas spent; 0 = the failure cost nothing)`);
}
void rpcUrl;
