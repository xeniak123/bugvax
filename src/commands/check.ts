import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describeMatches } from "../agent.js";
import { scan, type Match, type RuleDoc } from "../core/engine.js";
import {
  changedFiles,
  diffHunks,
  git,
  isTracked,
  newRange,
  overlaps,
  repoRelative,
  repoRoot,
  showFile,
  untrackedFiles,
  type Hunk,
} from "../core/git.js";
import { languageOf } from "../core/languages.js";
import { Store } from "../core/store.js";
import { githubAnnotations, header, pc, plural, printFindings } from "../ui.js";

export interface CheckOptions {
  staged?: boolean;
  base?: string;
  allLines?: boolean;
  hook?: string;
  json?: boolean;
}

export const HOOK_TYPES = ["claude-code", "cursor", "gemini", "codex"] as const;
export type HookType = (typeof HOOK_TYPES)[number];

/**
 * Check changed code against every antibody. Only findings on changed lines count, so an old
 * latent bug elsewhere in a file does not block an unrelated change (use --all-lines for that).
 */
export async function checkCommand(files: string[], opts: CheckOptions): Promise<number> {
  if (opts.hook) return hookCheck(opts.hook);
  const root = await repoRoot(process.cwd());
  const store = new Store(root);
  const antibodies = await store.antibodies();
  if (!antibodies.length) return 0;
  const rules = antibodies.map((a) => a.doc);
  const globs = await excludeGlobs(store);

  let matches: Match[];
  if (files.length) {
    const paths = files.map((f) => repoRelative(root, f)).filter((p): p is string => p !== null);
    matches = await scan(rules, paths, root, { globs });
  } else if (opts.staged) {
    const paths = (await changedFiles(root, ["--cached"])).filter((p) => languageOf(p));
    matches = await scanIndex(rules, root, paths, globs);
    if (!opts.allLines) matches = onChangedLines(matches, await diffHunks(root, ["--cached"], paths));
  } else if (opts.base) {
    const baseRev = (await git(root, ["merge-base", opts.base, "HEAD"])).trim();
    const paths = (await changedFiles(root, [baseRev])).filter((p) => languageOf(p));
    matches = await scan(rules, paths, root, { globs });
    if (!opts.allLines) matches = onChangedLines(matches, await diffHunks(root, [baseRev], paths));
  } else {
    matches = await checkWorkingChanges(root, rules, globs, { allLines: opts.allLines });
  }

  if (opts.json) {
    console.log(JSON.stringify(matches, null, 2));
    return matches.length ? 1 : 0;
  }
  if (!matches.length) {
    console.log(pc.green("🧬 bugvax: no known bugs in these changes."));
    return 0;
  }
  header("check");
  printFindings(matches, antibodies);
  githubAnnotations(matches, antibodies);
  console.log(`\n  ${pc.red(pc.bold(plural(matches.length, "known bug")))} re-introduced. Fix them, or edit the antibody if it is wrong.\n`);
  return 1;
}

async function excludeGlobs(store: Store): Promise<string[]> {
  return (await store.config()).exclude.map((g) => (g.startsWith("!") ? g : `!${g}`));
}

function onChangedLines(matches: Match[], changed: Map<string, Hunk[]>): Match[] {
  return matches.filter((m) => changed.get(m.file)?.some((h) => h.newLines > 0 && overlaps([m.line, m.endLine], newRange(h))));
}

/**
 * Findings in uncommitted work: on changed lines of tracked files, anywhere in new files.
 * `only` restricts the check to some repo-relative paths (e.g. the file an agent just edited).
 */
export async function checkWorkingChanges(
  root: string,
  rules: RuleDoc[],
  globs: string[],
  opts: { only?: string[]; allLines?: boolean } = {},
): Promise<Match[]> {
  let tracked: string[];
  let fresh: string[];
  if (opts.only) {
    tracked = [];
    fresh = [];
    for (const p of opts.only.filter((x) => languageOf(x))) ((await isTracked(root, p)) ? tracked : fresh).push(p);
  } else {
    tracked = (await changedFiles(root, ["HEAD"])).filter((p) => languageOf(p));
    fresh = (await untrackedFiles(root)).filter((p) => languageOf(p));
  }
  if (!tracked.length && !fresh.length) return [];
  const matches = await scan(rules, [...tracked, ...fresh], root, { globs });
  if (opts.allLines) return matches;
  const hunks = tracked.length ? await diffHunks(root, ["HEAD"], tracked) : new Map<string, Hunk[]>();
  const onChanged = new Set(onChangedLines(matches, hunks));
  const freshSet = new Set(fresh);
  return matches.filter((m) => onChanged.has(m) || freshSet.has(m.file));
}

/** Scan the staged (index) version of files, which is what is about to be committed. */
async function scanIndex(rules: RuleDoc[], root: string, paths: string[], globs: string[]): Promise<Match[]> {
  if (!paths.length) return [];
  const dir = await mkdtemp(join(tmpdir(), "bugvax-staged-"));
  try {
    for (const p of paths) {
      const content = await showFile(root, "", p);
      if (content === null) continue;
      await mkdir(dirname(join(dir, p)), { recursive: true });
      await writeFile(join(dir, p), content);
    }
    return await scan(rules, paths, dir, { globs });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface HookInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; path?: string; command?: string; patch?: string; input?: string };
  workspace_roots?: string[];
}

/** Files named in a Codex `apply_patch` patch ("*** Update File: path", "*** Add File: path"). */
export function patchFiles(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const m = /^\*\*\* (?:Update|Add) File: (.+)$/.exec(line.trim()) ?? /^\*\*\* Move to: (.+)$/.exec(line.trim());
    if (m) out.push(m[1].trim());
  }
  return [...new Set(out)];
}

/**
 * Agent hooks. After an agent edits code, check the changed lines and hand any re-introduced bug
 * back to the agent in the format its hook system understands:
 *  - claude-code: PostToolUse, exit code 2 + stderr
 *  - gemini:      AfterTool, stdout {hookSpecificOutput.additionalContext}
 *  - codex:       PostToolUse, stdout {decision: "block", reason}
 *  - cursor:      stop, stdout {followup_message}: the agent gets one more turn to fix it
 */
async function hookCheck(kind: string): Promise<number> {
  if (!(HOOK_TYPES as readonly string[]).includes(kind)) {
    console.error(`Unknown hook type: ${kind}. Use one of: ${HOOK_TYPES.join(", ")}`);
    return 1;
  }
  const type = kind as HookType;
  let input: HookInput = {};
  try {
    input = JSON.parse((await readStdin()) || "{}") as HookInput;
  } catch {
    /* no or malformed payload: treat as empty */
  }
  const cwd = input.cwd ?? input.workspace_roots?.[0] ?? process.cwd();
  const report = await hookReport(type, input, cwd).catch(() => null);
  return emit(type, report);
}

async function hookReport(type: HookType, input: HookInput, cwd: string): Promise<string | null> {
  let files: string[] | undefined;
  if (type === "claude-code" || type === "gemini") {
    const f = input.tool_input?.file_path ?? input.tool_input?.path;
    if (!f) return null;
    files = [f];
  } else if (type === "codex") {
    const t = input.tool_input ?? {};
    files = [...patchFiles(t.command ?? t.patch ?? t.input ?? ""), ...(t.file_path ? [t.file_path] : [])];
    if (!files.length) return null;
  }
  const root = await repoRoot(cwd);
  const store = new Store(root);
  const antibodies = await store.antibodies();
  if (!antibodies.length) return null;
  const only = files?.map((f) => repoRelative(root, f, cwd)).filter((p): p is string => p !== null);
  if (only && !only.length) return null;
  const matches = await checkWorkingChanges(root, antibodies.map((a) => a.doc), await excludeGlobs(store), { only });
  if (!matches.length) return null;
  return [
    `bugvax: ${type === "cursor" ? "your changes re-introduce" : "this edit re-introduces"} ${plural(matches.length, "bug")} that ${matches.length === 1 ? "was" : "were"} already fixed before.`,
    "",
    describeMatches(matches, antibodies),
    "",
    "Please fix these before continuing. If a finding is wrong, say so and explain why instead of working around it.",
  ].join("\n");
}

function emit(type: HookType, report: string | null): number {
  switch (type) {
    case "claude-code":
      if (!report) return 0;
      console.error(report);
      return 2;
    case "gemini":
      console.log(JSON.stringify(report ? { hookSpecificOutput: { hookEventName: "AfterTool", additionalContext: report } } : {}));
      return 0;
    case "codex":
      if (report) console.log(JSON.stringify({ decision: "block", reason: report }));
      return 0;
    case "cursor":
      console.log(JSON.stringify(report ? { followup_message: report } : {}));
      return 0;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
