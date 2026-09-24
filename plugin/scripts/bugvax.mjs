#!/usr/bin/env node
// Runs the bugvax CLI for the Claude Code plugin's hooks and MCP server, on every platform.
// Hook payloads (stdin), MCP traffic and exit codes all pass through as if bugvax ran directly.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const args = process.argv.slice(2);

/** Is `dir`, or a folder above it, a repository that uses bugvax? */
function upward(dir) {
  for (;;) {
    if (existsSync(join(dir, ".bugvax"))) return true;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/** Does this hook concern bugvax: the edited file's repository, the session's, or one directly inside it? */
function concernsBugvax(payload) {
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const file = payload.tool_input?.file_path ?? payload.tool_input?.path;
  if (typeof file === "string" && upward(dirname(isAbsolute(file) ? file : join(cwd, file)))) return true;
  if (upward(cwd)) return true;
  try {
    return readdirSync(cwd, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(join(cwd, e.name, ".bugvax")));
  } catch {
    return false;
  }
}

// Hooks fire on every edit in every project. Where bugvax is not set up there is nothing to
// check, so do not pay for starting npx at all.
let payload = null;
if (args.includes("--hook")) {
  const chunks = [];
  if (!process.stdin.isTTY) for await (const c of process.stdin) chunks.push(c);
  payload = Buffer.concat(chunks);
  let parsed = {};
  try {
    parsed = JSON.parse(payload.toString("utf8") || "{}");
  } catch {
    /* no or malformed payload: decide from the working directory */
  }
  if (!concernsBugvax(parsed ?? {})) process.exit(0);
}

// On Windows npx is a .cmd shim: run it through cmd.exe explicitly (shell: true with an argument
// list prints a deprecation warning on Node 24, which a blocking hook would show to the agent).
const windows = process.platform === "win32";
// npm notices on stderr would end up in the feedback a blocking hook gives the agent.
const env = { ...process.env, npm_config_loglevel: "error", npm_config_update_notifier: "false" };
const stdio = [payload ? "pipe" : "inherit", "inherit", "inherit"];
const child = windows
  ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npx", "--yes", "bugvax", ...args], { stdio, env })
  : spawn("npx", ["--yes", "bugvax", ...args], { stdio, env });
if (payload) {
  child.stdin.on("error", () => {}); // bugvax may exit without reading everything
  child.stdin.end(payload);
}
child.on("error", (error) => {
  console.error(`bugvax: could not start npx (${error.message}). Is Node.js installed?`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
