// Sends tGLM from index 0 (funder) to indexes 1..6. DO NOT run until the funder is funded.
// Usage: tsx scripts/arkiv/distribute.ts [amountTGLM=0.5]
import { parseEther } from "viem";
import { WALLET_ROLES, account, txUrl, walletFor } from "./lib";

const amount = parseEther(process.argv[2] ?? "0.5");
const funder = walletFor(0);
for (const i of Object.keys(WALLET_ROLES).map(Number).filter((n) => n > 0)) {
  const to = account(i).address;
  const hash = await funder.sendTransaction({ to, value: amount });
  await funder.waitForTransactionReceipt({ hash });
  console.log(`index ${i} ${to} <- ${process.argv[2] ?? "0.5"} tGLM ${txUrl(hash)}`);
}
