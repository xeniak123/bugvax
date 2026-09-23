import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { changedFiles, diffHunks, diffText, showFile, type Hunk } from "./git.js";
import { isTestFile, isVendoredOrGenerated, languageOf, type LanguageInfo } from "./languages.js";
import type { Candidate } from "./mine.js";

export interface FixFile {
  path: string;
  before: string;
  after: string;
  hunks: Hunk[];
}

/** One bug fix: the code before and after, ready to be turned into an antibody. */
export interface FixSample {
  /** Commit sha, or "working-tree". */
  key: string;
  kind: "commit" | "working-tree";
  sha?: string;
  short: string;
  date?: string;
  subject: string;
  body: string;
  language: LanguageInfo;
  files: FixFile[];
  diff: string;
  testDiff: string;
}

const MAX_TEST_DIFF = 6000;

export async function sampleFromCandidate(root: string, c: Candidate): Promise<FixSample> {
  const parent = `${c.commit.sha}^`;
  const paths = c.codeFiles.map((f) => f.path);
  const hunks = await diffHunks(root, [parent, c.commit.sha], paths);
  const files: FixFile[] = [];
  for (const path of paths) {
    const [before, after] = await Promise.all([showFile(root, parent, path), showFile(root, c.commit.sha, path)]);
    const h = hunks.get(path);
    if (before === null || after === null || !h?.length) continue;
    files.push({ path, before, after, hunks: h });
  }
  const testPaths = c.testFiles.map((f) => f.path);
  return {
    key: c.commit.sha,
    kind: "commit",
    sha: c.commit.sha,
    short: c.commit.short,
    date: c.commit.date,
    subject: c.commit.subject,
    body: c.commit.body,
    language: c.language,
    files,
    diff: await diffText(root, [parent, c.commit.sha], files.map((f) => f.path)),
    testDiff: truncate(await diffText(root, [parent, c.commit.sha], testPaths), MAX_TEST_DIFF),
  };
}

/**
 * The fix you just made but have not committed yet: HEAD is the buggy version, the working tree
 * is the fixed one.
 */
export async function sampleFromWorkingTree(root: string, message: string): Promise<FixSample | null> {
  const changed = (await changedFiles(root, ["HEAD"])).filter((p) => languageOf(p) && !isVendoredOrGenerated(p));
  const code = changed.filter((p) => !isTestFile(p));
  const tests = changed.filter((p) => isTestFile(p));
  if (!code.length) return null;

  const hunks = await diffHunks(root, ["HEAD"], code);
  const byLang = new Map<string, { lang: LanguageInfo; lines: number; paths: string[] }>();
  for (const p of code) {
    const lang = languageOf(p)!;
    const lines = (hunks.get(p) ?? []).reduce((n, h) => n + h.oldLines + h.newLines, 0);
    const e = byLang.get(lang.id) ?? { lang, lines: 0, paths: [] };
    e.lines += lines;
    e.paths.push(p);
    byLang.set(lang.id, e);
  }
  const primary = [...byLang.values()].sort((a, b) => b.lines - a.lines)[0];
  const files: FixFile[] = [];
  for (const path of primary.paths) {
    const before = await showFile(root, "HEAD", path);
    const h = hunks.get(path);
    if (before === null || !h?.length) continue;
    files.push({ path, before, after: await readFile(join(root, path), "utf8"), hunks: h });
  }
  if (!files.length) return null;
  const testPaths = tests.filter((p) => languageOf(p)?.id === primary.lang.id);
  return {
    key: "working-tree",
    kind: "working-tree",
    short: "working tree",
    subject: message,
    body: "",
    language: primary.lang,
    files,
    diff: await diffText(root, ["HEAD"], files.map((f) => f.path)),
    testDiff: truncate(await diffText(root, ["HEAD"], testPaths), MAX_TEST_DIFF),
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n… (truncated)\n" : s;
}
