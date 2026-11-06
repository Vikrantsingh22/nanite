/* `nanite-mcp keygen`: generate the agent's keys on this machine and print ONLY the public values. */
import { join, resolve } from "node:path";
import { DEFAULT_KEY_DIR, KEY_FILE_NAME, generateKeyFile, rotateSignerKey } from "./keyfile.js";

export const KEYGEN_USAGE = `Usage: nanite-mcp keygen [--out <dir>] [--force] [--passphrase-env <VAR>]

  --out <dir>             directory for agent-key.json (default ~/.nanite)
  --force                 overwrite an existing key file (the old agent keys are lost)
  --passphrase-env <VAR>  encrypt the key file with the passphrase in this environment variable
                          (Argon2id). Then also set NANITE_AGENT_KEY_PASSPHRASE when running the MCP server.`;

export const ROTATE_USAGE = `Usage: nanite-mcp rotate-signer [--file <path>]

  Replaces ONLY the signer key in your key file (default ~/.nanite/agent-key.json); the encryption key is kept, so old
  mail stays readable. Prints the new signer address: paste it into Nanite (agent settings, Mail signing).
  A passphrase-protected file needs NANITE_AGENT_KEY_PASSPHRASE.`;

export interface KeygenIO {
  /** Receives every line that is shown to the user (stdout). */
  out: (line: string) => void;
  env: Record<string, string | undefined>;
}

/** Returns the process exit code. Private keys are written to the key file only, never to `io.out`. */
export async function runKeygen(args: string[], io: KeygenIO): Promise<number> {
  let dir = DEFAULT_KEY_DIR;
  let force = false;
  let passphraseEnv: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out" && args[i + 1]) dir = resolve(args[++i]!);
    else if (a === "--force") force = true;
    else if (a === "--passphrase-env" && args[i + 1]) passphraseEnv = args[++i]!;
    else {
      io.out(KEYGEN_USAGE);
      return a === "--help" || a === "-h" ? 0 : 2;
    }
  }
  let passphrase: string | undefined;
  if (passphraseEnv) {
    passphrase = io.env[passphraseEnv];
    if (!passphrase) {
      io.out(`nanite-mcp keygen: environment variable ${passphraseEnv} is empty or not set`);
      return 2;
    }
  }
  const path = join(dir, KEY_FILE_NAME);
  let info;
  try {
    info = await generateKeyFile({ path, passphrase, force });
  } catch (e) {
    const code = (e as { code?: string }).code;
    io.out(code === "EEXIST" ? `nanite-mcp keygen: ${path} already exists (use --force to replace it; the old keys are lost)` : "nanite-mcp keygen: could not write the key file");
    return 1;
  }
  io.out("Agent keys generated on this machine.");
  io.out(`Key file:              ${path}  (mode 600${passphrase ? ", passphrase-encrypted" : ""}; the private keys never leave it)`);
  io.out("");
  io.out(`Encryption public key: ${info.encryptionPublicKey}`);
  io.out(`Signer address:        ${info.signerAddress}`);
  io.out("");
  io.out('Paste both into Nanite: Add agent -> "Hold the key yourself". Back up the key file: without it this agent\'s mail cannot be read.');
  return 0;
}

export { KEY_FILE_NAME };

/** `nanite-mcp rotate-signer`: new signer key in the same key file; prints only the new address. */
export async function runRotateSigner(args: string[], io: KeygenIO): Promise<number> {
  let file = join(DEFAULT_KEY_DIR, KEY_FILE_NAME);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) file = resolve(args[++i]!);
    else {
      io.out(ROTATE_USAGE);
      return args[i] === "--help" || args[i] === "-h" ? 0 : 2;
    }
  }
  try {
    const info = await rotateSignerKey(file, io.env.NANITE_AGENT_KEY_PASSPHRASE);
    io.out("Signer key replaced in the key file (the encryption key is unchanged).");
    io.out(`Signer address: ${info.signerAddress}`);
    io.out("Paste it into Nanite: agent settings -> Mail signing -> Rotate signer address. Until ENS holds it, mail signed with the new key is rejected.");
    return 0;
  } catch (e) {
    io.out(`nanite-mcp rotate-signer: ${e instanceof Error ? e.message : "failed"}`);
    return 1;
  }
}
