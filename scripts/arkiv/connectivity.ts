// Read-only connectivity check via the SDK.
import { gt } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import { CHAIN_ID, publicClient } from "./lib";

const pc = publicClient();
const chainId = await pc.getChainId();
console.log("chainId", chainId, chainId === CHAIN_ID ? "ok" : "MISMATCH");
console.log("blockNumber", await pc.getBlockNumber());
console.log("blockTiming", await pc.getBlockTiming());
const page = await pc.select({ $key: true, $owner: true, $expiresAt: true }).where(gt("$expiresAt", u64(0))).limit(3).fetch();
console.log("query rows", page.entities.length, "at block", page.blockNumber);
for (const e of page.entities) console.log(" ", e.$key, e.$owner, e.$expiresAt);
