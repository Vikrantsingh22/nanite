// Fills empty wallet keys in .env. Prints ADDRESSES ONLY. Idempotent.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount, generateMnemonic, english, mnemonicToAccount } from "viem/accounts";

const ENV = ".env";
const lines = existsSync(ENV) ? readFileSync(ENV, "utf8").split("\n") : [];

function get(key: string): string {
  const l = lines.find((x) => x.startsWith(key + "="));
  return l ? l.slice(key.length + 1).trim() : "";
}
function set(key: string, value: string): boolean {
  const i = lines.findIndex((x) => x.startsWith(key + "="));
  if (i >= 0) {
    if (lines[i].slice(key.length + 1).trim() !== "") return false;
    lines[i] = `${key}=${value}`;
  } else {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(`${key}=${value}`, "");
  }
  return true;
}

set("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com");
set("OPERATOR_PRIVATE_KEY", generatePrivateKey());
set("TEST_USER_PRIVATE_KEY", generatePrivateKey());
set("TEST_SEED_MNEMONIC", generateMnemonic(english));
writeFileSync(ENV, lines.join("\n"), { mode: 0o600 });

const mnemonic = get("TEST_SEED_MNEMONIC") || lines.find((x) => x.startsWith("TEST_SEED_MNEMONIC="))!.split("=")[1];
const op = privateKeyToAccount(lines.find((x) => x.startsWith("OPERATOR_PRIVATE_KEY="))!.split("=")[1] as `0x${string}`);
const tu = privateKeyToAccount(lines.find((x) => x.startsWith("TEST_USER_PRIVATE_KEY="))!.split("=")[1] as `0x${string}`);
console.log("operator   ", op.address);
console.log("test user  ", tu.address);
for (const i of [0, 1]) {
  console.log(`agent ${i}    `, mnemonicToAccount(mnemonic, { addressIndex: i }).address, `(m/44'/60'/0'/0/${i})`);
}
