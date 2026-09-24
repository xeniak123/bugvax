import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../util/proc.js";
import { applyFixes, EngineError, scan, type Match, type RuleDoc } from "./engine.js";
import { newRange, oldRange, overlaps, parseHunks, type Hunk } from "./git.js";
import type { FixSample } from "./sample.js";
import { windows } from "./snippets.js";

export interface Validation {
  ok: boolean;
  compileError?: string;
  /** Matches in the buggy (pre-fix) code that overlap the lines the fix changed. */
  buggyHits: Match[];
  buggyTotal: number;
  /** Matches in the fixed code near the lines the fix changed. */
  fixedHits: Match[];
  fixedTotal: number;
  /** Matches in the current working tree: latent copies of the bug, or noise if there are too many. */
  headMatches: Match[];
  tooBroad: boolean;
  /** Why validation failed, written for the model that produced the rule. */
  feedback?: string;
}

export interface ValidateOptions {
  maxHeadMatches: number;
  globs?: string[];
}

/** Slack (in lines) when checking that the fixed code no longer matches near the change. */
const FIXED_SLACK = 2;

/**
 * The core of bugvax: an antibody is only kept if it (1) matches the buggy code where the fix
 * happened, (2) no longer matches after the fix, and (3) is not so broad that it lights up the
 * whole codebase.
 */
export async function validate(rule: RuleDoc, sample: FixSample, root: string, opts: ValidateOptions): Promise<Validation> {
  const empty: Validation = { ok: false, buggyHits: [], buggyTotal: 0, fixedHits: [], fixedTotal: 0, headMatches: [], tooBroad: false };
  const dir = await mkdtemp(join(tmpdir(), "bugvax-validate-"));
  let matches: Match[];
  try {
    for (const f of sample.files) {
      for (const [side, content] of [["before", f.before], ["after", f.after]] as const) {
        const p = join(dir, side, f.path);
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, content);
      }
    }
    // Explicit files, not directories: ast-grep skips hidden directories (.github/, .storybook/) when it walks.
    matches = await scan([rule], sample.files.flatMap((f) => [`before/${f.path}`, `after/${f.path}`]), dir);
  } catch (e) {
    if (e instanceof EngineError) return { ...empty, compileError: e.message, feedback: explainCompileError(e.message, sample) };
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const byPath = new Map(sample.files.map((f) => [f.path, f]));
  const side = (m: Match, s: string) => (m.file.startsWith(`${s}/`) ? m.file.slice(s.length + 1) : null);
  const before = matches.filter((m) => side(m, "before") !== null).map((m) => ({ ...m, file: side(m, "before")! }));
  const after = matches.filter((m) => side(m, "after") !== null).map((m) => ({ ...m, file: side(m, "after")! }));

  const buggyHits = before.filter((m) => byPath.get(m.file)?.hunks.some((h) => overlaps([m.line, m.endLine], oldRange(h))));
  const fixedHits = after.filter((m) => byPath.get(m.file)?.hunks.some((h) => overlaps([m.line, m.endLine], newRange(h, FIXED_SLACK))));
  const result: Validation = { ...empty, buggyHits, buggyTotal: before.length, fixedHits, fixedTotal: after.length };

  if (!buggyHits.length) return { ...result, feedback: explainMissedBug(sample, before) };
  if (fixedHits.length || after.length >= before.length) return { ...result, feedback: explainStillFires(sample, fixedHits.length ? fixedHits : after) };

  const headMatches = await scan([rule], ["."], root, { globs: opts.globs });
  const tooBroad = headMatches.length > opts.maxHeadMatches;
  if (tooBroad) {
    return { ...result, headMatches, tooBroad, feedback: explainTooBroad(headMatches, opts.maxHeadMatches) };
  }
  return { ...result, headMatches, ok: true };
}

function explainCompileError(message: string, sample: FixSample): string {
  const hints: string[] = [];
  if (/Try adding `kind`|must specify a set of AST kinds/i.test(message)) {
    hints.push(
      "Your `pattern` did not parse as a complete, valid code snippet in this language. Use a snippet that parses on its own " +
        "(e.g. a full call expression or statement), or use `pattern: {context: <valid code>, selector: <node kind>}`, " +
        "or match with `kind` + `has`/`regex` instead.",
    );
  }
  if (/Invalid Kind|kind .* is invalid/i.test(message)) {
    hints.push(`Use real tree-sitter node kinds for ${sample.language.label}. Common kinds: ${sample.language.kinds}.`);
  }
  if (/unknown field/i.test(message)) hints.push("Use only the rule keys listed in the reference.");
  return ["ast-grep rejected the rule:", "```", message, "```", ...hints].join("\n");
}

function explainMissedBug(sample: FixSample, elsewhere: Match[]): string {
  const parts = [
    "Validation failed: the rule does NOT match the buggy code at the lines the fix changed (marked with >).",
    "It must match at least one node that overlaps those lines in the BEFORE version:",
  ];
  for (const f of sample.files) {
    parts.push(`\n${f.path} (before the fix)`, "```", windows(f.before, f.hunks.map((h) => oldRange(h)), 3, 60), "```");
  }
  if (elsewhere.length) {
    parts.push("\nIt matched only unrelated places instead:");
    for (const m of elsewhere.slice(0, 5)) parts.push(`- ${m.file}:${m.line}: ${oneLine(m.lines)}`);
  } else {
    parts.push("\nIt matched nothing at all in the buggy files. Check that your pattern is valid code for this language and that relational rules use `stopBy: end` where needed.");
  }
  return parts.join("\n");
}

function explainStillFires(sample: FixSample, hits: Match[]): string {
  const parts = ["Validation failed: the rule still matches the FIXED code, so it cannot tell the bug from the fix."];
  for (const m of hits.slice(0, 5)) {
    const f = sample.files.find((x) => x.path === m.file);
    parts.push(`\n${m.file}:${m.line} (after the fix)`);
    if (f) parts.push("```", windows(f.after, [[m.line, m.endLine]], 2, 20), "```");
  }
  parts.push("\nAdd the condition that the fix removed (e.g. `not: {inside/has: ...}` for the added guard, await or argument).");
  return parts.join("\n");
}

function explainTooBroad(head: Match[], max: number): string {
  const parts = [
    `Validation failed: the rule matches ${head.length} places in the current codebase (limit ${max}). That is too broad for one bug class, so most of these are probably correct code. Examples:`,
  ];
  for (const m of head.slice(0, 6)) parts.push(`- ${m.file}:${m.line}: ${oneLine(m.lines)}`);
  parts.push("\nMake the rule more specific: require the exact condition that made the original code buggy.");
  return parts.join("\n");
}

function oneLine(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > 140 ? t.slice(0, 140) + "…" : t;
}

export interface FixProof {
  ok: boolean;
  /** How many buggy sites the template rewrote. */
  fixed: number;
  feedback?: string;
}

/**
 * An auto-fix is only kept if it is proven on history: applying the rule's `fix:` template to the
 * buggy code must reproduce what the human fix actually did at those lines (whitespace aside), and
 * the rule must no longer match there. A template that "removes the match" but differs from the
 * real fix (e.g. `tags=[]` -> `tags=None` without the `if tags is None` guard) is rejected.
 */
export async function proveFix(rule: RuleDoc, sample: FixSample, buggyHits: Match[]): Promise<FixProof> {
  const hits = buggyHits.filter((m) => m.fix);
  if (!hits.length) return { ok: false, fixed: 0, feedback: "The fix template produced no replacement for the buggy code." };
  const dir = await mkdtemp(join(tmpdir(), "bugvax-fix-"));
  try {
    const problems: string[] = [];
    const fixedRanges = new Map<string, [number, number][]>();
    let fixed = 0;
    let changedFiles = 0;
    for (const f of sample.files) {
      const fileHits = hits.filter((m) => m.file === f.path);
      if (!fileHits.length) continue;
      const { content, applied } = applyFixes(Buffer.from(f.before, "utf8"), fileHits);
      fixed += applied.length;
      const fixedBefore = content.toString("utf8");
      const paths = Object.fromEntries(
        (["before", "fixed", "after"] as const).map((side) => [side, join(dir, side, f.path)]),
      ) as Record<"before" | "fixed" | "after", string>;
      for (const [side, text] of [["before", f.before], ["fixed", fixedBefore], ["after", f.after]] as const) {
        await mkdir(dirname(paths[side]), { recursive: true });
        await writeFile(paths[side], text);
      }
      const strict = sample.language.id === "python"; // indentation is syntax
      const changes = (await noIndexHunks(paths.before, paths.fixed, strict)).map((h) => newRange(h, 1));
      if (!changes.length) {
        problems.push(`${f.path}: the fix template does not change the buggy code.`);
        continue;
      }
      changedFiles++;
      fixedRanges.set(f.path, changes);
      const residual = (await noIndexHunks(paths.fixed, paths.after, strict)).filter((h) => changes.some((r) => overlaps(oldRange(h), r)));
      if (residual.length) {
        problems.push(
          `${f.path}: your fix template turns the buggy code into this (changed lines marked >):`,
          "```",
          windows(fixedBefore, changes.map(([a, b]) => [a + 1, b - 1] as [number, number]), 3, 40),
          "```",
          "but the real fix looks different there:",
          "```",
          windows(f.after, residual.map((h) => newRange(h)), 3, 40),
          "```",
        );
      }
    }
    if (!fixed || !changedFiles) return { ok: false, fixed: 0, feedback: "The fix template did not change the buggy code." };
    if (problems.length) return { ok: false, fixed, feedback: problems.join("\n") };

    const targets = (side: string) => sample.files.filter((f) => fixedRanges.has(f.path)).map((f) => `${side}/${f.path}`);
    // The rewritten code must still parse.
    const parseErrors: RuleDoc = { id: "parse-error", language: rule.language, rule: { kind: "ERROR" } };
    const errors = await scan([parseErrors], [...targets("before"), ...targets("fixed")], dir);
    const count = (side: string) => errors.filter((m) => m.file.startsWith(`${side}/`)).length;
    if (count("fixed") > count("before")) {
      return { ok: false, fixed, feedback: "Applying the fix template produces code that no longer parses. Keep the syntax valid (indentation, brackets, commas)." };
    }

    // The rewritten code must not trigger the rule again at the rewritten lines.
    const { fix: _fix, ...plain } = rule;
    const again = await scan([plain as RuleDoc], targets("fixed"), dir);
    const still = again.filter((m) => {
      const path = m.file.replace(/^fixed\//, "");
      return fixedRanges.get(path)?.some((r) => overlaps([m.line, m.endLine], r));
    });
    if (still.length) return { ok: false, fixed, feedback: "After applying the fix template, the rule still matches the rewritten code." };
    return { ok: true, fixed };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Zero-context hunks between two files, ignoring whitespace (only trailing whitespace when
 * `strict`, for languages where indentation matters). User diff settings (external diff tools,
 * textconv, prefixes) must not change the output.
 */
async function noIndexHunks(a: string, b: string, strict = false): Promise<Hunk[]> {
  const res = await run("git", [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-index",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--no-color",
    "-U0",
    strict ? "--ignore-space-at-eol" : "-w",
    "--ignore-cr-at-eol",
    "--",
    a,
    b,
  ]);
  if (res.code > 1) throw new Error(`git diff --no-index failed: ${res.stderr.trim()}`);
  return [...parseHunks(res.stdout).values()].flat();
}

/** The id of an existing antibody that already catches this sample's bug, if any. */
export async function coveredBy(rules: RuleDoc[], sample: FixSample): Promise<string | null> {
  if (!rules.length || !sample.files.length) return null;
  const dir = await mkdtemp(join(tmpdir(), "bugvax-covered-"));
  try {
    for (const f of sample.files) {
      const p = join(dir, "before", f.path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, f.before);
    }
    const matches = await scan(rules, sample.files.map((f) => `before/${f.path}`), dir);
    const byPath = new Map(sample.files.map((f) => [f.path, f]));
    for (const m of matches) {
      const f = byPath.get(m.file.replace(/^before\//, ""));
      if (f?.hunks.some((h) => overlaps([m.line, m.endLine], oldRange(h)))) return m.ruleId;
    }
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Numbered context around a match in the working tree, for reports and reviews. */
export async function matchContext(root: string, m: Match, context = 3): Promise<string> {
  try {
    const content = await readFile(join(root, m.file), "utf8");
    return windows(content, [[m.line, m.endLine]], context, 30);
  } catch {
    return m.lines;
  }
}
