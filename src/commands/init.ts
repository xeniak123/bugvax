import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { git, repoRoot } from "../core/git.js";
import { Store } from "../core/store.js";
import { header, pc } from "../ui.js";

export interface InitOptions {
  claudeCode?: boolean;
  cursor?: boolean;
  gemini?: boolean;
  codex?: boolean;
  mcp?: boolean;
  gitHook?: boolean;
  /** Override the command hooks run (defaults to `npx -y bugvax`). */
  command?: string;
}

const MARKER = "bugvax";

export async function initCommand(opts: InitOptions): Promise<number> {
  const root = await repoRoot(process.cwd());
  const store = new Store(root);
  const created = await store.init();
  const bin = opts.command ?? "npx -y bugvax";
  header("init", root);
  console.log(created ? pc.green("  ✓ created .bugvax/") : pc.dim("  · .bugvax/ already exists"));

  if (opts.claudeCode) console.log(await installClaudeCodeHook(root, bin));
  if (opts.cursor) console.log(await installCursorHook(root, bin));
  if (opts.gemini) console.log(await installGeminiHook(root, bin));
  if (opts.codex) console.log(await installCodexHook(root, bin));
  if (opts.mcp) for (const line of await installMcp(root, opts.command)) console.log(line);
  if (opts.gitHook) console.log(await installGitHook(root, bin));

  const agents = opts.claudeCode || opts.cursor || opts.gemini || opts.codex;
  console.log(`
  Next steps:
    ${pc.bold("bugvax learn")}        learn antibodies from your bug-fix history
    ${pc.bold("bugvax scan")}         find latent copies of old bugs
    ${pc.bold("bugvax fix")}          repair them where a proven fix exists${agents ? "" : `
    ${pc.bold("bugvax init --claude-code | --cursor | --gemini | --codex")}   check every edit your agent makes`}${opts.mcp ? "" : `
    ${pc.bold("bugvax init --mcp")}   let any MCP-capable agent ask bugvax before it writes code`}${opts.gitHook ? "" : `
    ${pc.bold("bugvax init --git-hook")}      block commits that re-introduce known bugs`}
`);
  return 0;
}

type Json = Record<string, any>;

/** Read a JSON config, apply `change`, write it back. Existing settings are always kept. */
async function editJson(path: string, change: (json: Json) => string | null): Promise<string> {
  let json: Json = {};
  if (existsSync(path)) {
    try {
      json = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return pc.red(`  ✗ ${path} is not valid JSON; add bugvax to it by hand (see README).`);
    }
  }
  const result = change(json);
  if (result === null) return "";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(json, null, 2) + "\n");
  return result;
}

function hasBugvax(entries: unknown[]): boolean {
  return JSON.stringify(entries).includes(MARKER);
}

/** Claude Code: PostToolUse on every edit; exit code 2 hands findings back to the agent. */
export async function installClaudeCodeHook(root: string, bin: string): Promise<string> {
  let already = false;
  const msg = await editJson(join(root, ".claude", "settings.json"), (s) => {
    s.hooks ??= {};
    s.hooks.PostToolUse ??= [];
    if (hasBugvax(s.hooks.PostToolUse)) return ((already = true), null);
    s.hooks.PostToolUse.push({ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: `${bin} check --hook claude-code` }] });
    return pc.green("  ✓ Claude Code: every edit is checked (.claude/settings.json)");
  });
  return already ? pc.dim("  · Claude Code hook already installed") : msg;
}

/** Cursor: a `stop` hook. If the finished work re-introduces a known bug, the agent gets a follow-up turn to fix it. */
export async function installCursorHook(root: string, bin: string): Promise<string> {
  let already = false;
  const msg = await editJson(join(root, ".cursor", "hooks.json"), (s) => {
    s.version ??= 1;
    s.hooks ??= {};
    s.hooks.stop ??= [];
    if (hasBugvax(s.hooks.stop)) return ((already = true), null);
    s.hooks.stop.push({ command: `${bin} check --hook cursor` });
    return pc.green("  ✓ Cursor: the agent's changes are checked before it finishes (.cursor/hooks.json)");
  });
  return already ? pc.dim("  · Cursor hook already installed") : msg;
}

/** Gemini CLI: AfterTool on file writes; findings are appended to the tool result. */
export async function installGeminiHook(root: string, bin: string): Promise<string> {
  let already = false;
  const msg = await editJson(join(root, ".gemini", "settings.json"), (s) => {
    s.hooks ??= {};
    s.hooks.AfterTool ??= [];
    if (hasBugvax(s.hooks.AfterTool)) return ((already = true), null);
    s.hooks.AfterTool.push({
      matcher: "write_file|replace",
      hooks: [{ type: "command", name: "bugvax", command: `${bin} check --hook gemini`, timeout: 60000 }],
    });
    return pc.green("  ✓ Gemini CLI: every file write is checked (.gemini/settings.json)");
  });
  return already ? pc.dim("  · Gemini CLI hook already installed") : msg;
}

/** Codex: PostToolUse on apply_patch; findings replace the tool result so the model acts on them. */
export async function installCodexHook(root: string, bin: string): Promise<string> {
  let already = false;
  const msg = await editJson(join(root, ".codex", "hooks.json"), (s) => {
    s.hooks ??= {};
    s.hooks.PostToolUse ??= [];
    if (hasBugvax(s.hooks.PostToolUse)) return ((already = true), null);
    s.hooks.PostToolUse.push({
      matcher: "apply_patch|Edit|Write",
      hooks: [{ type: "command", command: `${bin} check --hook codex`, statusMessage: "bugvax: checking for known bugs", timeout: 60 }],
    });
    return pc.green("  ✓ Codex: every patch is checked (.codex/hooks.json)");
  });
  return already ? pc.dim("  · Codex hook already installed") : msg;
}

/** MCP server config for Claude Code (.mcp.json) and Cursor (.cursor/mcp.json). */
export async function installMcp(root: string, command?: string): Promise<string[]> {
  const server = command
    ? { command: command.split(" ")[0], args: [...command.split(" ").slice(1), "mcp"] }
    : process.platform === "win32"
      ? { command: "cmd", args: ["/c", "npx", "-y", "bugvax", "mcp"] }
      : { command: "npx", args: ["-y", "bugvax", "mcp"] };
  const out: string[] = [];
  for (const [file, label] of [
    [".mcp.json", "Claude Code"],
    [join(".cursor", "mcp.json"), "Cursor"],
  ] as const) {
    let already = false;
    const msg = await editJson(join(root, file), (s) => {
      s.mcpServers ??= {};
      if (s.mcpServers.bugvax) return ((already = true), null);
      s.mcpServers.bugvax = server;
      return pc.green(`  ✓ MCP server for ${label} (${file.replace(/\\/g, "/")})`);
    });
    out.push(already ? pc.dim(`  · ${label} MCP server already configured`) : msg);
  }
  return out;
}

/** Install a pre-commit hook, unless the repo already has one we should not overwrite. */
export async function installGitHook(root: string, bin: string): Promise<string> {
  const hooksDir = (await git(root, ["rev-parse", "--git-path", "hooks"])).trim();
  const dir = isAbsolute(hooksDir) ? hooksDir : join(root, hooksDir);
  const path = join(dir, "pre-commit");
  const line = `${bin} check --staged || exit 1`;
  if (existsSync(path)) {
    const current = await readFile(path, "utf8");
    if (current.includes(MARKER)) return pc.dim("  · git pre-commit hook already installed");
    return pc.yellow(`  ! ${path} already exists (husky, lefthook, …?). Add this line to it yourself:\n      ${line}`);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path, `#!/bin/sh\n# bugvax: block commits that re-introduce bugs this repository already fixed\n${line}\n`);
  await chmod(path, 0o755);
  return pc.green("  ✓ git pre-commit hook installed");
}
