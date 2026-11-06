// Ensures ARKIV_TEST_MNEMONIC exists in .env (never overwrites), prints addresses + tGLM balances only.
import { appendFileSync, readFileSync } from "node:fs";
import { generateMnemonic, english } from "viem/accounts";
import { formatEther } from "viem";
import { WALLET_ROLES, account, publicClient } from "./lib";

if (!process.env.ARKIV_TEST_MNEMONIC) {
  const env = readFileSync(".env", "utf8");
  if (/^ARKIV_TEST_MNEMONIC=/m.test(env)) throw new Error("ARKIV_TEST_MNEMONIC is in .env but empty; fix it by hand");
  appendFileSync(".env", `${env.endsWith("\n") ? "" : "\n"}ARKIV_TEST_MNEMONIC="${generateMnemonic(english)}"\n`);
  console.log("generated ARKIV_TEST_MNEMONIC and appended to .env (not printed). Re-run to see addresses.");
  process.exit(0);
}
const pc = publicClient();
for (const [i, role] of Object.entries(WALLET_ROLES)) {
  const a = account(Number(i)).address;
  const bal = await pc.getBalance({ address: a }).then(formatEther, () => "?(rpc unreachable)");
  console.log(String(i), role.padEnd(12), a, bal, "tGLM");
}
