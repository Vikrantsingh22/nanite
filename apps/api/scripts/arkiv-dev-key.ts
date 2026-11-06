/*
 * DEV ONLY. Fills the local .env (gitignored) with the values the api needs for a full local run,
 * only where they are missing or empty (existing values are never overwritten, nothing secret is printed):
 *
 *   ARKIV_OPERATOR_PRIVATE_KEY  derived from ARKIV_TEST_MNEMONIC at index 3 (the funded W3 operator)
 *   RESEND_WEBHOOK_SECRET       random whsec_<base64> (dev value; replace with Resend's in production)
 *   SENDER_HASH_SECRET          random 64 hex chars
 *
 * With --dev-flags it also adds DEV_ROUTES=1 and FAKE_RESEND_CONTENT=1 (canned mail, dev inbox route).
 * Remove those two lines from .env when you switch to real Resend mail.
 *
 *   docker compose run --rm tools npx tsx apps/api/scripts/arkiv-dev-key.ts [--dev-flags]
 *
 * Prints only the operator ADDRESS and the names of the variables it added.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
const flags = process.argv.includes("--dev-flags");

let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const lines = text.split("\n");
const valueOf = (name: string): string | undefined => {
  const line = lines.find((l) => l.startsWith(`${name}=`));
  if (line === undefined) return undefined;
  return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
};

const added: string[] = [];
function setIfMissing(name: string, make: () => string): void {
  if (valueOf(name)) return; // present and non-empty: never overwrite
  const value = make();
  const idx = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (idx >= 0) lines[idx] = `${name}=${value}`;
  else {
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(`${name}=${value}`, "");
  }
  added.push(name);
}

const mnemonic = valueOf("ARKIV_TEST_MNEMONIC") ?? process.env.ARKIV_TEST_MNEMONIC;
let address: string | undefined;
if (mnemonic) {
  const operator = mnemonicToAccount(mnemonic, { addressIndex: 3 });
  address = operator.address;
  setIfMissing("ARKIV_OPERATOR_PRIVATE_KEY", () => bytesToHex(operator.getHdKey().privateKey!) as Hex);
} else if (!valueOf("ARKIV_OPERATOR_PRIVATE_KEY")) {
  console.error("ARKIV_TEST_MNEMONIC is not set in .env: cannot derive the Arkiv operator key");
  process.exit(1);
}
setIfMissing("RESEND_WEBHOOK_SECRET", () => `whsec_${randomBytes(24).toString("base64")}`);
setIfMissing("SENDER_HASH_SECRET", () => randomBytes(32).toString("hex"));
if (flags) {
  setIfMissing("DEV_ROUTES", () => "1");
  setIfMissing("FAKE_RESEND_CONTENT", () => "1");
}

if (added.length > 0) {
  text = lines.join("\n");
  writeFileSync(envPath, text, { mode: 0o600 });
}
console.log(`arkiv operator address (index 3): ${address ?? "(operator key already in .env)"}`);
console.log(added.length > 0 ? `added to .env: ${added.join(", ")}` : "nothing to add: .env already has every value");
