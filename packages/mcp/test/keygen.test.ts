import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runKeygen, runRotateSigner } from "../src/cli.js";
import { generateKeyFile, loadKeyFile } from "../src/keyfile.js";

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "nanite-keygen-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("nanite-mcp keygen", () => {
  it("writes a mode-600 key file and prints ONLY public values", async () => {
    const dir = await tmp();
    const lines: string[] = [];
    const code = await runKeygen(["--out", dir], { out: (l) => lines.push(l), env: {} });
    expect(code).toBe(0);
    const file = join(dir, "agent-key.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const f = JSON.parse(await readFile(file, "utf8"));
    const printed = lines.join("\n");
    expect(printed).toContain(f.encryptionPublicKey);
    expect(printed).toContain(f.signerAddress);
    expect(f.encryptionPublicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/); // the format POST /agents expects
    expect(f.signerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Nothing secret is printed: neither private key, in any common encoding.
    const privB64: string = f.encryptionPrivateKey;
    const privHex = Buffer.from(privB64, "base64").toString("hex");
    for (const secret of [privB64, privHex, f.signerPrivateKey, f.signerPrivateKey.slice(2)]) expect(printed).not.toContain(secret);
  });

  it("round trips through loadKeyFile and refuses to overwrite without --force", async () => {
    const dir = await tmp();
    const path = join(dir, "agent-key.json");
    const info = await generateKeyFile({ path });
    const key = await loadKeyFile(path);
    expect(key.keyId).toBe(info.keyId);
    expect(key.signerAddress).toBe(info.signerAddress);
    expect(Buffer.from(key.publicKey).toString("base64")).toBe(info.encryptionPublicKey);
    await expect(generateKeyFile({ path })).rejects.toMatchObject({ code: "EEXIST" });
    const lines: string[] = [];
    expect(await runKeygen(["--out", dir], { out: (l) => lines.push(l), env: {} })).toBe(1);
    expect(lines.join("\n")).toMatch(/already exists/);
    expect(await runKeygen(["--out", dir, "--force"], { out: () => undefined, env: {} })).toBe(0);
    expect((await loadKeyFile(path)).keyId).not.toBe(info.keyId);
  });

  it("passphrase-protected file: private keys are not in the file and need the passphrase", async () => {
    const dir = await tmp();
    const path = join(dir, "agent-key.json");
    const info = await generateKeyFile({ path, passphrase: "correct horse battery" });
    const raw = await readFile(path, "utf8");
    const f = JSON.parse(raw);
    expect(f.encrypted).toBe(true);
    expect(f).not.toHaveProperty("encryptionPrivateKey");
    expect(f).not.toHaveProperty("signerPrivateKey");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(loadKeyFile(path)).rejects.toThrow(/passphrase/);
    await expect(loadKeyFile(path, "wrong")).rejects.toThrow(/wrong passphrase/);
    const key = await loadKeyFile(path, "correct horse battery");
    expect(key.signerAddress).toBe(info.signerAddress);
  });

  it("--passphrase-env reads the passphrase from the environment, never from argv", async () => {
    const dir = await tmp();
    expect(await runKeygen(["--out", dir, "--passphrase-env", "PW"], { out: () => undefined, env: {} })).toBe(2);
    const lines: string[] = [];
    expect(await runKeygen(["--out", dir, "--passphrase-env", "PW"], { out: (l) => lines.push(l), env: { PW: "s3cret-pass" } })).toBe(0);
    expect(lines.join("\n")).not.toContain("s3cret-pass");
    expect(JSON.parse(await readFile(join(dir, "agent-key.json"), "utf8")).encrypted).toBe(true);
  });

  it("rejects an inconsistent or broken key file with fixed messages", async () => {
    const dir = await tmp();
    const path = join(dir, "agent-key.json");
    await generateKeyFile({ path });
    const f = JSON.parse(await readFile(path, "utf8"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ ...f, signerAddress: "0x" + "00".repeat(20) }), { mode: 0o600 });
    await expect(loadKeyFile(path)).rejects.toThrow(/inconsistent/);
    await writeFile(path, "not json", { mode: 0o600 });
    await expect(loadKeyFile(path)).rejects.toThrow(/not valid JSON/);
    await expect(loadKeyFile(join(dir, "missing.json"))).rejects.toThrow(/cannot read/);
  });

  it("rotate-signer replaces ONLY the signer key (old mail stays readable), keeps mode 600 and the passphrase, prints only the address", async () => {
    for (const passphrase of [undefined, "pass phrase 1"]) {
      const dir = await tmp();
      const path = join(dir, "agent-key.json");
      const info = await generateKeyFile({ path, passphrase });
      const before = await loadKeyFile(path, passphrase);
      const lines: string[] = [];
      const env = passphrase ? { NANITE_AGENT_KEY_PASSPHRASE: passphrase } : {};
      expect(await runRotateSigner(["--file", path], { out: (l) => lines.push(l), env })).toBe(0);
      const after = await loadKeyFile(path, passphrase);
      expect(after.signerAddress).not.toBe(info.signerAddress);
      expect(lines.join("\n")).toContain(after.signerAddress);
      expect(after.keyId).toBe(info.keyId);
      expect(Buffer.from(after.privateKey).toString("hex")).toBe(Buffer.from(before.privateKey).toString("hex"));
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, "utf8")).encrypted).toBe(!!passphrase);
      for (const secret of [after.signerPrivateKey, after.signerPrivateKey.slice(2), Buffer.from(after.privateKey).toString("base64")]) expect(lines.join("\n")).not.toContain(secret);
    }
    const lines: string[] = [];
    expect(await runRotateSigner(["--file", join(await tmp(), "nope.json")], { out: (l) => lines.push(l), env: {} })).toBe(1);
  });
});
