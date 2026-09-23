import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { run } from "../util/proc.js";

export interface Hunk {
  /** 1-based first line in the old file; for pure insertions this is the line *after which* lines were added. */
  oldStart: number;
  oldLines: number;
  /** 1-based first line in the new file; for pure deletions this is the line *after which* lines were removed. */
  newStart: number;
  newLines: number;
}

export interface FileStat {
  path: string;
  added: number;
  deleted: number;
}

export interface CommitInfo {
  sha: string;
  short: string;
  date: string;
  subject: string;
  body: string;
  files: FileStat[];
}

export async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const res = await run("git", args, { cwd, input });
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout;
}

/** Like `git`, but returns null instead of throwing. */
export async function gitMaybe(cwd: string, args: string[]): Promise<string | null> {
  const res = await run("git", args, { cwd });
  return res.code === 0 ? res.stdout : null;
}

/**
 * Resolve symlinks and Windows 8.3 short names, so paths coming from outside (an agent's hook
 * payload, the shell) can be compared with the repo root git reports.
 */
export function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    try {
      return join(realpathSync.native(dirname(p)), basename(p)); // e.g. a file that was just deleted
    } catch {
      return p;
    }
  }
}

/** `file` relative to `root` with forward slashes, or null when it is outside the repository. */
export function repoRelative(root: string, file: string, cwd = process.cwd()): string | null {
  const abs = isAbsolute(file) ? file : join(cwd, file);
  const rel = relative(canonical(root), canonical(abs)).replace(/\\/g, "/");
  return rel.startsWith("../") || rel === ".." || isAbsolute(rel) ? null : rel;
}

export async function repoRoot(cwd: string): Promise<string> {
  const out = await gitMaybe(cwd, ["rev-parse", "--show-toplevel"]);
  if (out === null) throw new Error("Not inside a git repository. bugvax learns from git history, so run it inside a repo.");
  return out.trim();
}

const RS = "\x1e";
const US = "\x1f";

/** A commit from the cheap history listing: message and modified paths, no line stats yet. */
export interface CommitHead {
  sha: string;
  short: string;
  date: string;
  subject: string;
  body: string;
  paths: string[];
}

/**
 * Non-merge commits, newest first, with the paths of modified files. Uses only trees (no file
 * contents), so it stays fast on huge histories and on partial ("blobless") clones.
 */
export async function listCommits(cwd: string, opts: { maxCount: number; since?: string }): Promise<CommitHead[]> {
  const args = [
    "log",
    "--no-merges",
    "--no-renames",
    "--diff-filter=M",
    `--max-count=${opts.maxCount}`,
    `--format=${RS}%H${US}%h${US}%aI${US}%s${US}%b${US}`,
    "--name-only",
  ];
  if (opts.since) args.push(`--since=${opts.since}`);
  const out = await gitMaybe(cwd, args);
  if (out === null) return []; // e.g. empty repository
  return parseLogHeads(out);
}

export function parseLogHeads(out: string): CommitHead[] {
  const heads: CommitHead[] = [];
  for (const chunk of out.split(RS)) {
    if (!chunk.trim()) continue;
    const parts = chunk.split(US);
    if (parts.length < 6) continue;
    const [sha, short, date, subject, body, rest] = parts;
    const paths = rest.split("\n").map((l) => l.trim()).filter(Boolean);
    heads.push({ sha: sha.trim(), short: short.trim(), date: date.trim(), subject: subject.trim(), body: body.trim(), paths });
  }
  return heads;
}

/** Per-file line stats of one commit's modified files. Reads file contents, so call it only for promising commits. */
export async function withStats(cwd: string, head: CommitHead): Promise<CommitInfo> {
  const out = await git(cwd, ["show", "--no-renames", "--diff-filter=M", "--numstat", "--format=", head.sha]);
  const { paths: _paths, ...rest } = head;
  return { ...rest, files: parseNumstat(out) };
}

function parseNumstat(out: string): FileStat[] {
  const files: FileStat[] = [];
  for (const line of out.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m || m[1] === "-") continue; // binary
    files.push({ path: m[3], added: Number(m[1]), deleted: Number(m[2]) });
  }
  return files;
}

export function parseLog(out: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const chunk of out.split(RS)) {
    if (!chunk.trim()) continue;
    const parts = chunk.split(US);
    if (parts.length < 6) continue;
    const [sha, short, date, subject, body, rest] = parts;
    commits.push({ sha: sha.trim(), short: short.trim(), date: date.trim(), subject: subject.trim(), body: body.trim(), files: parseNumstat(rest) });
  }
  return commits;
}

export async function commitInfo(cwd: string, rev: string): Promise<CommitInfo> {
  const out = await git(cwd, [
    "show",
    "--no-renames",
    "--diff-filter=M",
    `--format=${RS}%H${US}%h${US}%aI${US}%s${US}%b${US}`,
    "--numstat",
    rev,
  ]);
  const [c] = parseLog(out);
  if (!c) throw new Error(`Could not read commit ${rev}`);
  return c;
}

export async function hasParent(cwd: string, sha: string): Promise<boolean> {
  const out = await git(cwd, ["rev-list", "--parents", "-n", "1", sha]);
  return out.trim().split(/\s+/).length > 1;
}

/** File content at a revision (`rev` may be "" for the index, i.e. `git show :path`). */
export async function showFile(cwd: string, rev: string, path: string): Promise<string | null> {
  return gitMaybe(cwd, ["show", `${rev}:${path}`]);
}

export function parseHunks(diff: string): Map<string, Hunk[]> {
  const byFile = new Map<string, Hunk[]>();
  let current: Hunk[] | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p === "/dev/null") {
        current = null;
        continue;
      }
      const path = p.replace(/^b\//, "");
      current = byFile.get(path) ?? [];
      byFile.set(path, current);
      continue;
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && current) {
      current.push({
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
      });
    }
  }
  return byFile;
}

/** Zero-context hunks for a diff. `range` is passed straight to `git diff` (e.g. ["a", "b"], ["--cached"], ["HEAD"]). */
export async function diffHunks(cwd: string, range: string[], paths?: string[]): Promise<Map<string, Hunk[]>> {
  const args = ["diff", "-U0", "--no-color", "--no-renames", "--no-ext-diff", ...range];
  if (paths && paths.length) args.push("--", ...paths);
  return parseHunks(await git(cwd, args));
}

export async function diffText(cwd: string, range: string[], paths: string[], context = 3): Promise<string> {
  if (!paths.length) return "";
  return git(cwd, ["diff", `-U${context}`, "--no-color", "--no-renames", "--no-ext-diff", ...range, "--", ...paths]);
}

export async function changedFiles(cwd: string, range: string[]): Promise<string[]> {
  const out = await git(cwd, ["diff", "--name-only", "--no-renames", "--diff-filter=ACMR", ...range]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function untrackedFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function isTracked(cwd: string, path: string): Promise<boolean> {
  return (await gitMaybe(cwd, ["ls-files", "--error-unmatch", "--", path])) !== null;
}

/** Old-file line range touched by a hunk, widened by `slack` lines. Pure insertions touch the lines around the insertion point. */
export function oldRange(h: Hunk, slack = 0): [number, number] {
  if (h.oldLines === 0) return [h.oldStart - slack, h.oldStart + 1 + slack];
  return [h.oldStart - slack, h.oldStart + h.oldLines - 1 + slack];
}

/** New-file line range touched by a hunk, widened by `slack` lines. */
export function newRange(h: Hunk, slack = 0): [number, number] {
  if (h.newLines === 0) return [h.newStart - slack, h.newStart + 1 + slack];
  return [h.newStart - slack, h.newStart + h.newLines - 1 + slack];
}

export function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}
