import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  /** Override the command hooks run (defaults to `npx -y --loglevel=error bugvax`). */
  command?: string;
}

const MARKER = "bugvax";

export async function initCommand(opts: InitOptions): Promise<number> {
  const root = await repoRoot(process.cwd());
  const store = new Store(root);
  const created = await store.init();
  // --loglevel=error keeps npm notices out of the feedback a blocking hook gives the agent.
  const bin = opts.command ?? "npx -y --loglevel=error bugvax";
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

/**
 * Claude Code, the same setup as the bugvax plugin:
 *  - SessionStart: a briefing on the bugs this repository fixed before and where copies still live
 *  - PostToolUse: every edit is checked; exit code 2 hands findings back to the agent
 *  - Stop: the agent's changes are checked before it finishes
 *  - the bugvax skill in .claude/skills/bugvax
 */
export async function installClaudeCodeHook(root: string, bin: string): Promise<string> {
  const hook = (args: string) => ({ type: "command", command: `${bin} ${args}`, timeout: 60 });
  const events: [string, Json][] = [
    ["SessionStart", { hooks: [hook("context --hook claude-code")] }],
    ["PostToolUse", { matcher: "Edit|Write|MultiEdit", hooks: [hook("check --hook claude-code")] }],
    ["Stop", { hooks: [hook("check --hook claude-code-stop")] }],
  ];
  const added: string[] = [];
  const msg = await editJson(join(root, ".claude", "settings.json"), (s) => {
    s.hooks ??= {};
    for (const [event, entry] of events) {
      s.hooks[event] ??= [];
      if (hasBugvax(s.hooks[event])) continue;
      s.hooks[event].push(entry);
      added.push(event);
    }
    return added.length ? pc.green(`  ✓ Claude Code: session briefing, a check after every edit and before finishing (.claude/settings.json)`) : null;
  });
  const skill = await installSkill(root);
  const lines = [added.length || msg ? msg : pc.dim("  · Claude Code hooks already installed"), skill].filter(Boolean);
  return lines.join("\n");
}

/** Copy the bugvax skill, which tells the agent how to use bugvax, into .claude/skills. */
async function installSkill(root: string): Promise<string> {
  const target = join(root, ".claude", "skills", "bugvax", "SKILL.md");
  if (existsSync(target)) return pc.dim("  · Claude Code skill already installed");
  const source = fileURLToPath(new URL("../../plugin/skills/bugvax/SKILL.md", import.meta.url));
  if (!existsSync(source)) return "";
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(source, "utf8"));
  return pc.green("  ✓ Claude Code skill (.claude/skills/bugvax/SKILL.md)");
}

/**
 * Cursor: `afterFileEdit` remembers which files the agent edited, and a `stop` hook checks them.
 * If the finished work re-introduces a known bug, the agent gets a follow-up turn to fix it.
 */
export async function installCursorHook(root: string, bin: string): Promise<string> {
  let added = 0;
  const msg = await editJson(join(root, ".cursor", "hooks.json"), (s) => {
    s.version ??= 1;
    s.hooks ??= {};
    for (const [event, command] of [
      ["afterFileEdit", `${bin} check --hook cursor-edit`],
      ["stop", `${bin} check --hook cursor`],
    ]) {
      s.hooks[event] ??= [];
      if (hasBugvax(s.hooks[event])) continue;
      s.hooks[event].push({ command });
      added++;
    }
    return added ? pc.green("  ✓ Cursor: the files the agent edits are checked before it finishes (.cursor/hooks.json)") : null;
  });
  return added ? msg : pc.dim("  · Cursor hook already installed");
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
