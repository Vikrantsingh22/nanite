/*
 * Proof for demo/self-hosted that Nanite holds only ciphertext for a self-hosted agent. Prints statuses, field NAMES and
 * booleans only: never email content, never the token.
 *
 *   docker compose run --rm -e NANITE_AGENT_TOKEN="$NANITE_SELF_AGENT_TOKEN" -e API_URL=http://api:4000 tools \
 *     npx tsx demo/scripts/prove-self-custody.ts <entityKey> --needle="a word from the mail" [--needle=...]
 *
 * (1) GET /v1/emails/<key> without ?raw=1 must answer 409 self_custody; with ?raw=1 it returns the encrypted envelope only.
 * (2) The raw arkiv_query for that entity (selecting every stored attribute) must not contain any needle.
 * Needs ARKIV_OPERATOR_PRIVATE_KEY in .env (only its address is derived, to pin $creator).
 */
import { privateKeyToAccount } from "viem/accounts";
import { ApiClient, entityLink, loadLiveEnv, rawQueryByKey } from "../../apps/api/scripts/lib/live.js";

const key = process.argv.slice(2).find((a) => !a.startsWith("--"));
const needles = process.argv.filter((a) => a.startsWith("--needle=")).map((a) => a.slice(9).toLowerCase()).filter(Boolean);
const token = process.env.NANITE_AGENT_TOKEN;
if (!key || !token) {
  console.error("usage: NANITE_AGENT_TOKEN=... prove-self-custody.ts <entityKey> [--needle=text ...]");
  process.exit(2);
}
const env = loadLiveEnv();
const api = new ApiClient(env.apiUrl, env.webOrigin);
const say = (l: string) => console.log(l);

const plain = await api.get(`/v1/emails/${key}`, { token });
say(`[1] GET /v1/emails/<key>          -> ${plain.status} ${plain.json?.error ?? ""}   (expected 409 self_custody)`);
const raw = await api.get(`/v1/emails/${key}?raw=1`, { token });
const fields = Object.keys(raw.json ?? {});
const rawText = JSON.stringify(raw.json ?? {}).toLowerCase();
say(`    GET /v1/emails/<key>?raw=1     -> ${raw.status}; fields: ${fields.join(", ")}`);
say(`    plaintext fields present (subject/body/untrusted/text): ${["subject", "body", "untrusted", "text"].some((k) => fields.includes(k))}`);
if (needles.length) say(`    needles found in API responses: ${needles.map((n) => rawText.includes(n) || JSON.stringify(plain.json ?? {}).toLowerCase().includes(n)).join(", ")}`);

if (!env.arkivOperatorKey) {
  say("[2] skipped: ARKIV_OPERATOR_PRIVATE_KEY missing in .env");
} else {
  const q = await rawQueryByKey(env.arkivRpc, key, privateKeyToAccount(env.arkivOperatorKey).address);
  const lower = q.raw.toLowerCase();
  say(`[2] raw arkiv_query: ${q.entities.length} entity, ${q.raw.length} bytes of response`);
  say(`    needles found in the Arkiv entity: ${needles.length ? needles.map((n) => lower.includes(n)).join(", ") : "(no --needle given)"}   (expected false)`);
  say(`    explorer: ${entityLink(key)}`);
}
process.exit(0);
