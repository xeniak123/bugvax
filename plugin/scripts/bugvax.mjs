#!/usr/bin/env node
// Runs the bugvax CLI for the Claude Code plugin's hooks and MCP server, on every platform.
// stdio is passed through untouched, so hook payloads (stdin), MCP traffic and exit codes all work
// as if bugvax ran directly.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);

// Hooks fire on every edit in every project. Where bugvax is not set up there is nothing to
// check, so do not pay for starting npx at all.
function hasBugvax(dir) {
  for (;;) {
    if (existsSync(join(dir, ".bugvax"))) return true;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}
if (args.includes("--hook") && !hasBugvax(process.cwd())) process.exit(0);

// On Windows npx is a .cmd shim: run it through cmd.exe explicitly (shell: true with an argument
// list prints a deprecation warning on Node 24, which a blocking hook would show to the agent).
const windows = process.platform === "win32";
// npm notices on stderr would end up in the feedback a blocking hook gives the agent.
const env = { ...process.env, npm_config_loglevel: "error", npm_config_update_notifier: "false" };
const child = windows
  ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npx", "--yes", "bugvax", ...args], { stdio: "inherit", env })
  : spawn("npx", ["--yes", "bugvax", ...args], { stdio: "inherit", env });
child.on("error", (error) => {
  console.error(`bugvax: could not start npx (${error.message}). Is Node.js installed?`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
