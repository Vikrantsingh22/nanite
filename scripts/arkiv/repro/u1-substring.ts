// U1: does the Arkiv query language support substring (contains / LIKE / glob)? Read-only.
//   docker compose run --rm tools npx tsx scripts/arkiv/repro/u1-substring.ts
import { P, runCases } from "./lib";

await runCases("U1 substring / pattern matching on agentId", [
  { label: "baseline: exact match works", q: `${P} AND agentId = str('alex.vikrant.nanitecom.eth')` },
  { label: "STARTSWITH (documented) - prefix", q: `${P} AND agentId STARTSWITH str('alex.')` },
  { label: "STARTSWITH - prefix that matches nothing", q: `${P} AND agentId STARTSWITH str('zzz')` },
  { label: "STARTSWITH lower-case keyword", q: `${P} AND agentId startswith str('alex.')` },
  { label: "STARTSWITH function form (SDK style)", q: `${P} AND startsWith(agentId, str('alex.'))` },
  { label: "STARTSWITH for a middle fragment (should not match: it is prefix only)", q: `${P} AND agentId STARTSWITH str('vikrant')` },
  { label: "ENDSWITH", q: `${P} AND agentId ENDSWITH str('.eth')` },
  { label: "CONTAINS keyword", q: `${P} AND agentId CONTAINS str('vikrant')` },
  { label: "contains() function", q: `${P} AND contains(agentId, str('vikrant'))` },
  { label: "LIKE", q: `${P} AND agentId LIKE str('%vikrant%')` },
  { label: "glob operator ~", q: `${P} AND agentId ~ str('*vikrant*')` },
  { label: "GLOB keyword", q: `${P} AND agentId GLOB str('*vikrant*')` },
  { label: "= with wildcard (literal compare)", q: `${P} AND agentId = str('*vikrant*')` },
  { label: "IN list", q: `${P} AND agentId IN (str('alex.vikrant.nanitecom.eth'))` },
  { label: "NOT / != (negation)", q: `${P} AND agentId != str('zzz')` },
  { label: "NOT keyword", q: `${P} AND NOT agentId = str('zzz')` },
]);
