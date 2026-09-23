import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EngineError, scan, type Match, type RuleDoc } from "./engine.js";
import { newRange, oldRange, overlaps } from "./git.js";
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
    matches = await scan([rule], ["before", "after"], dir);
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
    const matches = await scan(rules, ["before"], dir);
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
