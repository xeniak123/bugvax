#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command, Option } from "commander";
import { checkCommand } from "./commands/check.js";
import { demoCommand } from "./commands/demo.js";
import { initCommand } from "./commands/init.js";
import { learnCommand } from "./commands/learn.js";
import { listCommand } from "./commands/list.js";
import { scanCommand } from "./commands/scan.js";
import { pc } from "./ui.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command()
  .name("bugvax")
  .description("Vaccinate your codebase: turn every bug you fixed into a rule that blocks the whole bug class, for humans and AI agents.")
  .version(version);

program
  .command("init")
  .description("create .bugvax/ and optionally install hooks")
  .option("--claude-code", "add a Claude Code hook that checks every file the agent edits")
  .option("--git-hook", "add a git pre-commit hook that blocks known bugs")
  .addOption(new Option("--command <cmd>", "command the hooks run").default(undefined).hideHelp())
  .action(async (opts) => exit(await initCommand(opts)));

program
  .command("learn")
  .description("learn antibodies from bug fixes in git history")
  .option("--limit <n>", "max number of fixes to analyze in this run", "15")
  .option("--max-commits <n>", "how far back in history to look", "2000")
  .option("--since <date>", "only look at commits after this date (e.g. 2025-01-01, '6 months ago')")
  .option("--commit <sha...>", "learn from specific commits, skipping the bug-fix heuristics")
  .option("--working", "learn from the fix you just made (uncommitted changes vs HEAD)")
  .option("-m, --message <text>", "what the uncommitted fix fixed (with --working)")
  .addOption(new Option("--provider <name>", "model backend").choices(["auto", "anthropic", "claude-code"]))
  .option("--model <model>", "model id or alias (default: claude-opus-5 for the API, your Claude Code default otherwise)")
  .addOption(new Option("--effort <level>", "reasoning effort").choices(["low", "medium", "high", "xhigh", "max"]))
  .option("--concurrency <n>", "fixes analyzed in parallel", "3")
  .option("--max-lines <n>", "skip commits that change more source lines than this", "80")
  .option("--retry", "retry commits that failed before")
  .option("--no-review", "skip the model review of matches found in current code")
  .option("--dry-run", "only list the commits that would be analyzed")
  .action(async (opts) => exit(await learnCommand(opts)));

program
  .command("scan")
  .description("find every place the codebase matches an antibody (latent copies of old bugs)")
  .argument("[paths...]", "files or directories to scan (default: whole repo)")
  .option("--json", "machine-readable output")
  .action(async (paths, opts) => exit(await scanCommand(paths, opts)));

program
  .command("check")
  .description("check changes for re-introduced bugs (for hooks and CI); default: uncommitted changes")
  .argument("[files...]", "check these whole files instead of a diff")
  .option("--staged", "check staged changes (pre-commit)")
  .option("--base <ref>", "check changes since the merge base with <ref> (CI), e.g. origin/main")
  .option("--all-lines", "report matches anywhere in changed files, not only on changed lines")
  .option("--hook <type>", "run as an agent hook (claude-code): read the edit from stdin, exit 2 to send feedback")
  .option("--json", "machine-readable output")
  .action(async (files, opts) => exit(await checkCommand(files, opts)));

program
  .command("list")
  .description("list antibodies")
  .option("--json", "machine-readable output")
  .action(async (opts) => exit(await listCommand(opts)));

program
  .command("demo")
  .description("create a demo repository with real-looking bug fixes to try bugvax on")
  .argument("[dir]", "where to create it", "demo-shop")
  .action(async (dir) => exit(await demoCommand(dir)));

function exit(code: number): void {
  process.exitCode = code;
}

program.parseAsync().catch((e: Error) => {
  console.error(pc.red(`bugvax: ${e.message}`));
  process.exitCode = 1;
});
