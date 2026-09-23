import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { scan, type Match } from "../core/engine.js";
import { changedFiles, diffHunks, git, isTracked, newRange, overlaps, repoRoot, showFile, untrackedFiles, type Hunk } from "../core/git.js";
import { languageOf } from "../core/languages.js";
import { antibodyMeta, Store, type Antibody } from "../core/store.js";
import { header, pc, plural, printFindings } from "../ui.js";

export interface CheckOptions {
  staged?: boolean;
  base?: string;
  allLines?: boolean;
  hook?: string;
  json?: boolean;
}

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
  const config = await store.config();
  const globs = config.exclude.map((g) => (g.startsWith("!") ? g : `!${g}`));

  let matches: Match[];
  let changed: Map<string, Hunk[]> | null = null;
  const newFiles = new Set<string>();
  if (files.length) {
    matches = await scan(rules, files.map((f) => toRepoPath(root, f)), root, { globs });
  } else if (opts.staged) {
    const paths = (await changedFiles(root, ["--cached"])).filter((p) => languageOf(p));
    changed = await diffHunks(root, ["--cached"], paths);
    matches = await scanIndex(rules, root, paths, globs);
  } else {
    const baseRev = opts.base ? (await git(root, ["merge-base", opts.base, "HEAD"])).trim() : "HEAD";
    const paths = (await changedFiles(root, [baseRev])).filter((p) => languageOf(p));
    changed = await diffHunks(root, [baseRev], paths);
    if (!opts.base) for (const p of await untrackedFiles(root)) if (languageOf(p)) newFiles.add(p);
    matches = await scan(rules, [...paths, ...newFiles], root, { globs });
  }
  if (changed && !opts.allLines) {
    const onChanged = new Set(onChangedLines(matches, changed));
    matches = matches.filter((m) => onChanged.has(m) || newFiles.has(m.file));
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
  console.log(`\n  ${pc.red(pc.bold(plural(matches.length, "known bug")))} re-introduced. Fix them, or edit the antibody if it is wrong.\n`);
  return 1;
}

function toRepoPath(root: string, f: string): string {
  const abs = isAbsolute(f) ? f : join(process.cwd(), f);
  return relative(root, abs).replace(/\\/g, "/");
}

function onChangedLines(matches: Match[], changed: Map<string, Hunk[]>): Match[] {
  return matches.filter((m) => changed.get(m.file)?.some((h) => h.newLines > 0 && overlaps([m.line, m.endLine], newRange(h))));
}

/** Scan the staged (index) version of files, which is what is about to be committed. */
async function scanIndex(rules: Antibody["doc"][], root: string, paths: string[], globs: string[]): Promise<Match[]> {
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
  tool_input?: { file_path?: string; path?: string };
}

/**
 * Claude Code PostToolUse hook: after the agent edits a file, check the edited lines. Exit code 2
 * sends stderr back to the agent, so it fixes the re-introduced bug on its own.
 */
async function hookCheck(kind: string): Promise<number> {
  if (kind !== "claude-code") {
    console.error(`Unknown hook type: ${kind}`);
    return 1;
  }
  let input: HookInput = {};
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch {
    return 0;
  }
  const file = input.tool_input?.file_path ?? input.tool_input?.path;
  if (!file || !languageOf(file)) return 0;
  let root: string;
  try {
    root = await repoRoot(input.cwd ?? process.cwd());
  } catch {
    return 0;
  }
  const store = new Store(root);
  const antibodies = await store.antibodies();
  if (!antibodies.length) return 0;
  const rel = relative(root, isAbsolute(file) ? file : join(input.cwd ?? process.cwd(), file)).replace(/\\/g, "/");
  if (rel.startsWith("..")) return 0;

  let matches = await scan(antibodies.map((a) => a.doc), [rel], root);
  if (await isTracked(root, rel)) matches = onChangedLines(matches, await diffHunks(root, ["HEAD"], [rel]));
  if (!matches.length) return 0;

  const lines = [
    `bugvax: this edit re-introduces ${plural(matches.length, "bug")} that this repository already fixed before.`,
    "",
  ];
  for (const m of matches) {
    const a = antibodies.find((x) => x.doc.id === m.ruleId);
    const meta = a ? antibodyMeta(a.doc) : undefined;
    lines.push(`${m.file}:${m.line}  [${m.ruleId}] ${m.message}`);
    lines.push(`  code: ${m.lines.split(/\r?\n/)[0].trim()}`);
    if (a?.doc.note) lines.push(`  fix: ${a.doc.note}`);
    if (meta?.source.commit) lines.push(`  history: fixed before in ${meta.source.commit.slice(0, 7)} "${meta.source.subject}"`);
    lines.push("");
  }
  lines.push("Please fix these before continuing. If a finding is wrong, say so and explain why instead of working around it.");
  console.error(lines.join("\n"));
  return 2;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
