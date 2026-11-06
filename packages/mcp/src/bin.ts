import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runKeygen, runRotateSigner } from "./cli.js";
import { createClient, type NaniteBackend } from "./client.js";
import { loadKeyFile } from "./keyfile.js";
import { createLocalBackend } from "./local.js";
import { createNaniteMcpServer } from "./server.js";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "keygen") {
  process.exit(await runKeygen(rest, { out: (l) => console.log(l), env: process.env }));
}

if (cmd === "rotate-signer") {
  process.exit(await runRotateSigner(rest, { out: (l) => console.log(l), env: process.env }));
}

const apiUrl = process.env.NANITE_API_URL?.trim();
const token = process.env.NANITE_AGENT_TOKEN?.trim();
if (!apiUrl || !token) {
  // stderr only: stdout is the MCP protocol channel. Never print the token.
  console.error("nanite-mcp: NANITE_API_URL and NANITE_AGENT_TOKEN are required (or run: nanite-mcp keygen)");
  process.exit(1);
}

const client = createClient({ apiUrl, token });
let backend: NaniteBackend = client;
const keyFile = process.env.NANITE_AGENT_KEY_FILE?.trim();
if (keyFile) {
  // Local mode: the key never leaves this machine; the API only sees ciphertext and signed requests.
  try {
    backend = createLocalBackend(client, await loadKeyFile(keyFile, process.env.NANITE_AGENT_KEY_PASSPHRASE));
  } catch (e) {
    console.error(`nanite-mcp: ${e instanceof Error ? e.message : "cannot load the agent key file"}`);
    process.exit(1);
  }
}

const server = createNaniteMcpServer(backend);
await server.connect(new StdioServerTransport());
