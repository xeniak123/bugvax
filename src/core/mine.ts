import type { CommitInfo, FileStat } from "./git.js";
import { isTestFile, isVendoredOrGenerated, languageOf, type LanguageInfo } from "./languages.js";

export interface Candidate {
  commit: CommitInfo;
  score: number;
  language: LanguageInfo;
  /** Changed source files in `language` (tests and vendored code excluded). */
  codeFiles: FileStat[];
  /** Changed test files: context for the model, often a regression test that proves the bug. */
  testFiles: FileStat[];
  changedLines: number;
}

export interface MineOptions {
  /** Upper bound on changed source lines; big commits are rarely a single, learnable bug. */
  maxLines: number;
  maxFiles: number;
}

export const DEFAULT_MINE: MineOptions = { maxLines: 80, maxFiles: 4 };

const STRONG = [
  /^(fix|bugfix|hotfix)(\([^)]*\))?!?:/i,
  /^\[?fix(es|ed)?\]?\b/i,
  /\b(fix(es|ed)?|close[sd]?|resolve[sd]?)\s+(#|gh-)\d+/i,
  /\bhot-?fix\b/i,
  /\bregression\b/i,
  /\bcrash(es|ed|ing)?\b/i,
  /\bbugs?\b|\bbug-?fix(es)?\b/i,
  /\b(napraw\w*|poprawk\w*|błąd|błędu|błędy)\b/iu,
];

const WEAK =
  /\b(fix(e[sd]|ing)?|bugs|broken|incorrect(ly)?|wrong(ly)?|leak(s|ing)?|race|deadlock|null|undefined|nil|none|npe|exception|panic|overflow|off[- ]by[- ]one|missing|forgot|prevent|guard|edge[- ]case|typeerror|keyerror|nullpointer|unhandled|infinite loop|hang(s|ing)?)\b/i;

/** Commits whose subject says they are about something other than a code bug. */
const NOT_A_BUG = [
  /^(docs|style|chore|ci|build|test|tests|refactor|perf|release)(\([^)]*\))?!?:/i,
  /^(revert|merge|bump|release|version|prepare)\b/i,
  /\bdependabot\b|\brenovate\b/i,
  /\bfix(es|ed|ing)?\s+(the\s+|a\s+|some\s+)?(typos?|lint(ing)?|linter|build|ci|docs?|documentation|readme|changelog|formatting|format|tests?|specs?|snapshots?|style|comments?|warnings?|types?|typings|deps|dependencies|links?|spelling|grammar|wording|flaky)\b/i,
  /\b(typo|spelling|grammar)\b/i,
];

export function scoreMessage(subject: string, body: string): number {
  if (NOT_A_BUG.some((r) => r.test(subject))) return 0;
  let score = 0;
  if (STRONG.some((r) => r.test(subject))) score += 3;
  else if (WEAK.test(subject)) score += 1.5;
  if (body && (STRONG.some((r) => r.test(body)) || WEAK.test(body))) score += 0.5;
  return score;
}

/** `force` skips the message and size heuristics, for commits the user picked explicitly. */
export function toCandidate(commit: CommitInfo, opts: MineOptions = DEFAULT_MINE, force = false): Candidate | null {
  const messageScore = scoreMessage(commit.subject, commit.body);
  if (!force && messageScore < 1.5) return null;

  const tests: FileStat[] = [];
  const byLang = new Map<string, { lang: LanguageInfo; files: FileStat[]; lines: number }>();
  for (const f of commit.files) {
    if (isVendoredOrGenerated(f.path)) continue;
    const lang = languageOf(f.path);
    if (!lang) continue;
    if (isTestFile(f.path)) {
      tests.push(f);
      continue;
    }
    const entry = byLang.get(lang.id) ?? { lang, files: [], lines: 0 };
    entry.files.push(f);
    entry.lines += f.added + f.deleted;
    byLang.set(lang.id, entry);
  }
  const primary = [...byLang.values()].sort((a, b) => b.lines - a.lines)[0];
  if (!primary) return null;
  if (primary.lines === 0) return null;
  if (!force && (primary.lines > opts.maxLines || primary.files.length > opts.maxFiles)) return null;

  let score = messageScore;
  if (primary.lines <= 10) score += 2;
  else if (primary.lines <= 30) score += 1;
  if (tests.length) score += 0.5;

  return {
    commit,
    score,
    language: primary.lang,
    codeFiles: primary.files,
    testFiles: tests.filter((t) => languageOf(t.path)?.id === primary.lang.id),
    changedLines: primary.lines,
  };
}

/** Rank likely bug-fix commits: best candidates first, newer first on ties. */
export function findCandidates(commits: CommitInfo[], opts: MineOptions = DEFAULT_MINE): Candidate[] {
  return commits
    .map((c) => toCandidate(c, opts))
    .filter((c): c is Candidate => c !== null)
    .sort((a, b) => b.score - a.score || b.commit.date.localeCompare(a.commit.date));
}
