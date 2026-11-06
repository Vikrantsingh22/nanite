#!/usr/bin/env node
// Launcher: runs the TypeScript entry through tsx (this workspace is not compiled).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const child = spawn(process.execPath, ["--import", "tsx", entry, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 1));
