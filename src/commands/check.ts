import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { describeMatches } from "../agent.js";
import { scan, type Match, type RuleDoc } from "../core/engine.js";
import {
  canonical,
  changedFiles,
  diffHunks,
  displayPrefix,
  git,
  isTracked,
  newRange,
  overlaps,
  repoRelative,
  repoRoot,
  repoRootOf,
  sessionRoots,
  showFile,
  untrackedFiles,
  type Hunk,
} from "../core/git.js";
import { languageOf } from "../core/languages.js";
import { Store, type Antibody } from "../core/store.js";
import { githubAnnotations, header, pc, plural, printFindings } from "../ui.js";

export interface CheckOptions {
  staged?: boolean;
  base?: string;
  allLines?: boolean;
  hook?: string;
  json?: boolean;
}

export const HOOK_TYPES = ["claude-code", "claude-code-stop", "cursor", "cursor-edit", "gemini", "codex"] as const;
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
  if (!antibodies.length) {
    if (opts.json) console.log("[]");
    return 0;
  }
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

export async function excludeGlobs(store: Store): Promise<string[]> {
  return (await store.config()).exclude.map((g) => (g.startsWith("!") ? g : `!${g}`));
}

function onChangedLines(matches: Match[], changed: Map<string, Hunk[]>): Match[] {
  // A pure deletion (newLines 0) counts too: deleting a guard line is a common way to re-introduce a bug.
  return matches.filter((m) => changed.get(m.file)?.some((h) => overlaps([m.line, m.endLine], newRange(h))));
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
  session_id?: string;
  conversation_id?: string;
  stop_hook_active?: boolean;
  loop_count?: number;
  file_path?: string;
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
 *  - claude-code:      PostToolUse, exit code 2 + stderr
 *  - claude-code-stop: Stop, exit code 2 + stderr: the agent keeps working until its changes are clean
 *  - gemini:           AfterTool, stdout {hookSpecificOutput.additionalContext}
 *  - codex:            PostToolUse, stdout {decision: "block", reason}
 *  - cursor-edit:      afterFileEdit, remembers which files the agent edited
 *  - cursor:           stop, stdout {followup_message}: the agent gets one more turn to fix it
 */
async function hookCheck(kind: string): Promise<number> {
  if (!(HOOK_TYPES as readonly string[]).includes(kind)) {
    console.error(`Unknown hook type: ${kind}. Use one of: ${HOOK_TYPES.join(", ")}`);
    return 1;
  }
  const type = kind as HookType;
  const input = await readHookInput();
  const cwd = input.cwd ?? input.workspace_roots?.[0] ?? process.cwd();
  if (type === "cursor-edit") {
    await recordCursorEdit(input, cwd).catch(() => {});
    return 0;
  }
  let report: string | null;
  try {
    report = await (type === "claude-code-stop" || type === "cursor" ? stopReport(type, input, cwd) : hookReport(type, input, cwd));
  } catch (e) {
    // Never block the agent on bugvax's own problem, but do not fail silently either: Claude Code
    // shows the stderr of a hook that exits 1 to the user.
    if (type !== "claude-code" && type !== "claude-code-stop") return emit(type, null);
    console.error(`bugvax could not check this change: ${(e as Error).message.split("\n")[0]}`);
    return 1;
  }
  return emit(type, report);
}

export async function readHookInput(): Promise<HookInput> {
  try {
    return JSON.parse((await readStdin()) || "{}") as HookInput;
  } catch {
    return {}; // no or malformed payload
  }
}

async function hookReport(type: HookType, input: HookInput, cwd: string): Promise<string | null> {
  let files: string[];
  if (type === "codex") {
    const t = input.tool_input ?? {};
    files = [...patchFiles(t.command ?? t.patch ?? t.input ?? ""), ...(t.file_path ? [t.file_path] : [])];
  } else {
    const f = input.tool_input?.file_path ?? input.tool_input?.path;
    files = f ? [f] : [];
  }
  if (!files.length) return null;
  // The repository of the edited file: the session may run in a folder that holds several repositories.
  const root = (await repoRootOf(isAbsolute(files[0]) ? files[0] : join(cwd, files[0]))) ?? (await repoRootOf(cwd));
  if (!root) return null; // not a git repository: nothing to check
  const store = new Store(root);
  const antibodies = await store.antibodies();
  if (!antibodies.length) return null;
  const only = files.map((f) => repoRelative(root, f, cwd)).filter((p): p is string => p !== null);
  if (!only.length) return null;
  const matches = await checkWorkingChanges(root, antibodies.map((a) => a.doc), await excludeGlobs(store), { only });
  if (!matches.length) return null;
  return [
    `bugvax: this edit re-introduces ${plural(matches.length, "bug")} that ${matches.length === 1 ? "was" : "were"} already fixed before.`,
    "",
    describeMatches(prefixed(matches, displayPrefix(cwd, root)), antibodies),
    "",
    "Please fix these before continuing. If a finding is wrong, say so and explain why instead of working around it.",
  ].join("\n");
}

/** The same findings block an agent from finishing at most this often; then it may stop and explain. */
const MAX_BLOCKS_PER_FINDING = 2;
const MAX_BLOCKS_PER_SESSION = 6;

/**
 * Before the agent finishes: check everything it changed in this session. Claude Code sessions
 * are compared with the snapshot `bugvax context` took at session start, so the user's own
 * uncommitted work is not blamed on the agent. Cursor sessions use the files its afterFileEdit
 * hook recorded.
 */
async function stopReport(type: HookType, input: HookInput, cwd: string): Promise<string | null> {
  const sessionId = input.session_id ?? input.conversation_id;
  const matches: Match[] = [];
  const antibodies: Antibody[] = [];
  for (const root of await sessionRoots(cwd)) {
    const found = await stopFindings(type, root, sessionId);
    if (!found) continue;
    matches.push(...prefixed(found.matches, displayPrefix(cwd, root)));
    antibodies.push(...found.antibodies);
  }
  if (!matches.length) return null;
  return [
    `bugvax: before you finish: your changes re-introduce ${plural(matches.length, "bug")} that this repository already fixed before.`,
    "",
    describeMatches(matches, antibodies),
    "",
    "Fix them now (where a proven fix is shown, `npx bugvax fix <file>` applies it), then finish.",
    "If a finding is a false positive, do not work around it or edit .bugvax/: say which one and explain why.",
  ].join("\n");
}

/** Findings in one repository that should block the agent from finishing, or null. */
async function stopFindings(type: HookType, root: string, sessionId: string | undefined): Promise<{ matches: Match[]; antibodies: Antibody[] } | null> {
  const store = new Store(root);
  const antibodies = await store.antibodies();
  if (!antibodies.length) return null;
  const session = await readSession(root, sessionId);
  let only: string[] | undefined;
  if (type === "cursor") {
    only = session.edited;
    if (!only.length) return null;
  } else if (session.baseline) {
    only = await touchedSince(root, session.baseline);
    if (!only.length) return null;
  }
  const matches = await checkWorkingChanges(root, antibodies.map((a) => a.doc), await excludeGlobs(store), { only });
  if (!matches.length) {
    if (Object.keys(session.blocks).length) await writeSession(root, sessionId, { ...session, blocks: {} });
    return null;
  }
  const fingerprint = matches.map((m) => `${m.ruleId}:${m.file}:${m.text}`).sort().join("\n");
  const key = createHash("sha1").update(fingerprint).digest("hex").slice(0, 16);
  const total = Object.values(session.blocks).reduce((n, c) => n + c, 0);
  if ((session.blocks[key] ?? 0) >= MAX_BLOCKS_PER_FINDING || total >= MAX_BLOCKS_PER_SESSION) return null;
  await writeSession(root, sessionId, { ...session, blocks: { ...session.blocks, [key]: (session.blocks[key] ?? 0) + 1 } });
  return { matches, antibodies };
}

/** Matches with paths relative to where the agent works. */
function prefixed(matches: Match[], prefix: string): Match[] {
  return prefix ? matches.map((m) => ({ ...m, file: prefix + m.file })) : matches;
}

function emit(type: HookType, report: string | null): number {
  switch (type) {
    case "claude-code":
    case "claude-code-stop":
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
    case "cursor-edit":
      return 0;
  }
}

/** Per-session hook state, kept outside the repository. */
interface Session {
  /** Hashes of the source files that were already uncommitted when the session started. */
  baseline?: Record<string, string>;
  /** Files the agent edited (Cursor afterFileEdit). */
  edited: string[];
  /** How often each set of findings has blocked the agent from finishing. */
  blocks: Record<string, number>;
}

function sessionFile(root: string, sessionId: string): string {
  const repo = createHash("sha1").update(canonical(root)).digest("hex").slice(0, 12);
  return join(tmpdir(), "bugvax-sessions", `${repo}-${sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`);
}

async function readSession(root: string, sessionId: string | undefined): Promise<Session> {
  const empty: Session = { edited: [], blocks: {} };
  if (!sessionId) return empty;
  try {
    return { ...empty, ...(JSON.parse(await readFile(sessionFile(root, sessionId), "utf8")) as Partial<Session>) };
  } catch {
    return empty;
  }
}

async function writeSession(root: string, sessionId: string | undefined, session: Session): Promise<void> {
  if (!sessionId) return;
  const file = sessionFile(root, sessionId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(session));
}

/** Uncommitted source files (changed or untracked) with a hash of their current content. */
async function workingSnapshot(root: string): Promise<Record<string, string>> {
  const files = [...(await changedFiles(root, ["HEAD"])), ...(await untrackedFiles(root))].filter((p) => languageOf(p));
  const out: Record<string, string> = {};
  for (const f of files) {
    try {
      out[f] = createHash("sha1").update(await readFile(join(root, f))).digest("hex");
    } catch {
      /* deleted in the meantime */
    }
  }
  return out;
}

/** Remember what was already uncommitted when an agent session started (SessionStart). */
export async function recordSessionStart(root: string, sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  const session = await readSession(root, sessionId);
  if (session.baseline) return; // a resumed or compacted session keeps its original snapshot
  await writeSession(root, sessionId, { ...session, baseline: await workingSnapshot(root) });
}

/** Uncommitted source files whose content changed since the baseline snapshot. */
async function touchedSince(root: string, baseline: Record<string, string>): Promise<string[]> {
  const now = await workingSnapshot(root);
  return Object.keys(now).filter((f) => baseline[f] !== now[f]);
}

async function recordCursorEdit(input: HookInput, cwd: string): Promise<void> {
  const file = input.file_path ?? input.tool_input?.file_path;
  const sessionId = input.conversation_id ?? input.session_id;
  if (!file || !sessionId) return;
  const root = (await repoRootOf(isAbsolute(file) ? file : join(cwd, file))) ?? (await repoRoot(cwd));
  const rel = repoRelative(root, file, cwd);
  if (!rel || !languageOf(rel)) return;
  const session = await readSession(root, sessionId);
  if (session.edited.includes(rel)) return;
  await writeSession(root, sessionId, { ...session, edited: [...session.edited, rel] });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
