import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "./client.js";
import { createNaniteMcpServer } from "./server.js";

const apiUrl = process.env.NANITE_API_URL?.trim();
const token = process.env.NANITE_AGENT_TOKEN?.trim();
if (!apiUrl || !token) {
  // stderr only: stdout is the MCP protocol channel. Never print the token.
  console.error("nanite-mcp: NANITE_API_URL and NANITE_AGENT_TOKEN are required");
  process.exit(1);
}

const server = createNaniteMcpServer(createClient({ apiUrl, token }));
await server.connect(new StdioServerTransport());
