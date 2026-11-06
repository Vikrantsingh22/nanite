/*
 * Connectivity check for the demo MCP servers, from the Docker network (nothing runs on the host).
 *
 *   docker compose run --rm -e NANITE_AGENT_TOKEN tools npx tsx demo/scripts/check-mcp.ts [--browse]
 *
 * - Playwright MCP (default http://browser:8931/mcp, override PLAYWRIGHT_MCP_URL): initialize + tools/list; with --browse it
 *   also navigates the headed browser to http://web:3000 and takes an accessibility snapshot (prints its size only).
 * - Nanite hosted MCP (default http://api:4000/mcp, override NANITE_MCP_URL): initialize + tools/list, only when
 *   NANITE_AGENT_TOKEN is set. The token is never printed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const browse = process.argv.includes("--browse");
const say = (l: string) => console.log(l);

async function open(url: string, headers?: Record<string, string>) {
  const client = new Client({ name: "demo-check", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: headers ? { headers } : undefined }));
  return client;
}

let failed = false;
try {
  const url = process.env.PLAYWRIGHT_MCP_URL ?? "http://browser:8931/mcp";
  const pw = await open(url);
  const tools = (await pw.listTools()).tools.map((t) => t.name);
  say(`[playwright] ${url}: ${tools.length} tools, e.g. ${tools.slice(0, 6).join(", ")}`);
  if (browse) {
    await pw.callTool({ name: "browser_navigate", arguments: { url: "http://web:3000" } });
    const snap = await pw.callTool({ name: "browser_snapshot", arguments: {} });
    const text = JSON.stringify(snap.content ?? "");
    say(`[playwright] navigated to http://web:3000, snapshot ${text.length} chars, isError=${Boolean(snap.isError)}`);
  }
  await pw.close();
} catch (e) {
  failed = true;
  say(`[playwright] FAILED: ${(e as Error).message}`);
}

const token = process.env.NANITE_AGENT_TOKEN;
if (token) {
  try {
    const url = process.env.NANITE_MCP_URL ?? "http://api:4000/mcp";
    const nm = await open(url, { Authorization: `Bearer ${token}` });
    const tools = (await nm.listTools()).tools.map((t) => t.name);
    say(`[nanite] ${url}: ${tools.length} tools: ${tools.join(", ")}`);
    await nm.close();
  } catch (e) {
    failed = true;
    say(`[nanite] FAILED: ${(e as Error).message.replaceAll(token, "<token>")}`);
  }
} else say("[nanite] skipped (NANITE_AGENT_TOKEN not set)");
process.exit(failed ? 1 : 0);
