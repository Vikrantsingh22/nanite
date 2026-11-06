// Validation helper: issue a SHORT-LIVED (15 min) agent token straight from the database and print it to stdout only.
// Use it inline, never paste the output anywhere:
//   T=$(docker compose run --rm -T tools npx tsx demo/scripts/issue-token.ts <agentId>) ; the token is passed on via env.
import { createDb } from "@nanite/db";
import { issueAgentToken } from "../../apps/api/src/agent-api/tokens";

const h = createDb(process.env.DATABASE_URL!);
const { token } = await issueAgentToken(h.db as any, process.argv[2]!, { label: "demo check", expiresAt: new Date(Date.now() + 15 * 60_000) });
process.stdout.write(token);
process.exit(0);
