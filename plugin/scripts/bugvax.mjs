#!/usr/bin/env node
// Runs the bugvax CLI for the Claude Code plugin's hooks and MCP server, on every platform.
// npx is a .cmd shim on Windows, which cannot be spawned without a shell; stdio is passed through
// untouched, so hook payloads (stdin), MCP traffic and exit codes all work as if bugvax ran directly.
import { spawn } from "node:child_process";

const windows = process.platform === "win32";
const child = spawn(windows ? "npx.cmd" : "npx", ["--yes", "bugvax", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: windows,
  env: process.env,
});
child.on("error", (error) => {
  console.error(`bugvax: could not start npx (${error.message}). Is Node.js installed?`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
