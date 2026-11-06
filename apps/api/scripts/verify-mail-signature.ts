/*
 * Verify the Nanite signature of one mail against the LIVE ENS record (Sepolia, UniversalResolverV2).
 *
 *   docker compose run --rm tools npx tsx apps/api/scripts/verify-mail-signature.ts mail.json [--rpc=<sepolia rpc url>]
 *
 * mail.json:
 *   {
 *     "headers": { "X-Nanite-Agent": "...", "X-Nanite-Date": "...", "X-Nanite-Signature": "0x...",
 *                  "X-Nanite-Sig-Version": "3", "X-Nanite-Message-Id": "<...>" },
 *     "from": "alex.nanitedemo@nanite.test", "to": "friend@example.com", "subject": "...", "body": "..."
 *   }
 *
 * Sig-Version 3 (current) signs the X-Nanite-Message-Id header, which providers keep. Sig-Version 2 (legacy) signs
 * the standard "Message-ID" header (put that in "headers" instead); Resend/Amazon SES REPLACE that header, so v2
 * mail delivered through Resend fails with signer_mismatch (the verdict then carries a "hint").
 *
 * Prints only the verdict (valid, agent, signer, reason), never the mail fields. Exit code 0 = valid, 1 = invalid,
 * 2 = bad usage or input. The SEPOLIA_RPC_URL env var is used when --rpc is not given.
 */
import { readFileSync } from "node:fs";
import { createSepoliaNameReader, verifyNaniteSignature } from "@nanite/ens";

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
const rpc = process.argv.find((a) => a.startsWith("--rpc="))?.slice(6) ?? process.env.SEPOLIA_RPC_URL;
if (!file) {
  console.error("usage: verify-mail-signature.ts <mail.json> [--rpc=<sepolia rpc url>]");
  process.exit(2);
}

let mail: unknown;
try {
  mail = JSON.parse(readFileSync(file, "utf8"));
} catch {
  console.error("cannot read or parse the JSON file");
  process.exit(2);
}
const m = mail as Record<string, unknown>;
const headers = m?.headers as Record<string, string> | undefined;
if (!headers || typeof headers !== "object" || ["from", "to", "subject", "body"].some((k) => typeof m[k] !== "string")) {
  console.error('the JSON needs "headers" (object) and string fields "from", "to", "subject", "body"');
  process.exit(2);
}

const result = await verifyNaniteSignature(
  { headers, from: m.from as string, to: m.to as string, subject: m.subject as string, body: m.body as string },
  { ensClient: createSepoliaNameReader(rpc) },
);
console.log(JSON.stringify(result, null, 2));
process.exit(result.valid ? 0 : 1);
