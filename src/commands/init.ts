import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { git, repoRoot } from "../core/git.js";
import { Store } from "../core/store.js";
import { header, pc } from "../ui.js";

export interface InitOptions {
  claudeCode?: boolean;
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
  if (opts.gitHook) console.log(await installGitHook(root, bin));

  console.log(`
  Next steps:
    ${pc.bold("bugvax learn")}        learn antibodies from your bug-fix history
    ${pc.bold("bugvax scan")}         find latent copies of old bugs
    ${pc.bold("bugvax check")}        check your uncommitted changes${opts.claudeCode ? "" : `
    ${pc.bold("bugvax init --claude-code")}   let Claude Code check every edit it makes`}${opts.gitHook ? "" : `
    ${pc.bold("bugvax init --git-hook")}      block commits that re-introduce known bugs`}
`);
  return 0;
}

/** Add a PostToolUse hook to .claude/settings.json, keeping everything already there. */
export async function installClaudeCodeHook(root: string, bin: string): Promise<string> {
  const path = join(root, ".claude", "settings.json");
  let settings: Record<string, any> = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return pc.red(`  ✗ ${path} is not valid JSON; add the hook by hand (see README).`);
    }
  }
  const command = `${bin} check --hook claude-code`;
  settings.hooks ??= {};
  settings.hooks.PostToolUse ??= [];
  const entries = settings.hooks.PostToolUse as { matcher?: string; hooks?: { type: string; command: string }[] }[];
  if (entries.some((e) => e.hooks?.some((h) => h.command.includes(MARKER)))) {
    return pc.dim("  · Claude Code hook already installed");
  }
  entries.push({ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command }] });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n");
  return pc.green("  ✓ Claude Code hook added to .claude/settings.json (every edit is checked; the agent fixes what it re-introduces)");
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
