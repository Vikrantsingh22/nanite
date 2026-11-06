/* Exercises the REAL launcher (bin/nanite-mcp.mjs -> tsx -> src/bin.ts) as a child process. */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(pkgDir, "bin", "nanite-mcp.mjs");

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "nanite-launcher-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("NANITE_")) env[k] = v;
  return { ...env, ...extra };
}

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, ...args], { cwd: pkgDir, env: baseEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function listTools(env: Record<string, string>): Promise<string[]> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [launcher], cwd: pkgDir, env: baseEnv(env), stderr: "pipe" });
  const client = new Client({ name: "launcher-test", version: "0.0.0" });
  try {
    await client.connect(transport); // performs the initialize handshake
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close().catch(() => undefined);
  }
}

const dummyApi = { NANITE_API_URL: "http://127.0.0.1:9", NANITE_AGENT_TOKEN: "dummy-token" };

describe("nanite-mcp launcher (real child process)", () => {
  it("keygen --out writes a mode-600 key file and prints only public values", async () => {
    const dir = await tmp();
    const r = await run(["keygen", "--out", dir]);
    expect(r.code, r.stderr).toBe(0);
    const file = join(dir, "agent-key.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const f = JSON.parse(await readFile(file, "utf8"));
    expect(r.stdout).toContain(f.encryptionPublicKey);
    expect(r.stdout).toContain(f.signerAddress);
    const privB64: string = f.encryptionPrivateKey;
    const privHex = Buffer.from(privB64, "base64").toString("hex");
    for (const secret of [privB64, privHex, f.signerPrivateKey, f.signerPrivateKey.slice(2)]) {
      expect(r.stdout).not.toContain(secret);
      expect(r.stderr).not.toContain(secret);
    }
  }, 30_000);

  it("rotate-signer --file gives a new signer address and keeps the encryption key", async () => {
    const dir = await tmp();
    const file = join(dir, "agent-key.json");
    expect((await run(["keygen", "--out", dir])).code).toBe(0);
    const before = JSON.parse(await readFile(file, "utf8"));
    const r = await run(["rotate-signer", "--file", file]);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.signerAddress).not.toBe(before.signerAddress);
    expect(r.stdout).toContain(after.signerAddress);
    expect(r.stdout).not.toContain(before.signerAddress);
    expect(after.encryptionPublicKey).toBe(before.encryptionPublicKey);
    expect(after.encryptionPrivateKey).toBe(before.encryptionPrivateKey);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(r.stdout).not.toContain(after.signerPrivateKey);
  }, 30_000);

  it("local mode (NANITE_AGENT_KEY_FILE) completes the MCP handshake and lists 7 tools", async () => {
    const dir = await tmp();
    expect((await run(["keygen", "--out", dir])).code).toBe(0);
    const tools = await listTools({ ...dummyApi, NANITE_AGENT_KEY_FILE: join(dir, "agent-key.json") });
    expect(tools).toHaveLength(7);
    expect(tools).toContain("extend_email");
    expect(tools).toContain("whoami");
  }, 30_000);

  it("hosted mode (no key file) lists 7 tools", async () => {
    const tools = await listTools(dummyApi);
    expect(tools).toHaveLength(7);
  }, 30_000);

  it("missing env: clear error on stderr, nothing on stdout, non-zero exit", async () => {
    const r = await run([]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/NANITE_API_URL and NANITE_AGENT_TOKEN are required/);
    expect(r.stdout).toBe("");
  }, 30_000);
});
