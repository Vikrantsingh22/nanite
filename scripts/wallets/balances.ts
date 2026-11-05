// Prints Sepolia ETH balances. Addresses and balances only.
import { createPublicClient, http, formatEther } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing in .env`);
  return v;
};
const client = createPublicClient({ chain: sepolia, transport: http(need("SEPOLIA_RPC_URL")) });
const mnemonic = need("TEST_SEED_MNEMONIC");
const rows: [string, string][] = [
  ["owner", "0x8fFD876f6200BCF671714E35b860aDFD57a6a542"],
  ["operator", privateKeyToAccount(need("OPERATOR_PRIVATE_KEY") as `0x${string}`).address],
  ["test user", privateKeyToAccount(need("TEST_USER_PRIVATE_KEY") as `0x${string}`).address],
  ["agent 0", mnemonicToAccount(mnemonic, { addressIndex: 0 }).address],
  ["agent 1", mnemonicToAccount(mnemonic, { addressIndex: 1 }).address],
];
for (const [role, addr] of rows) {
  const bal = await client.getBalance({ address: addr as `0x${string}` });
  console.log(role.padEnd(10), addr, formatEther(bal), "ETH");
}
