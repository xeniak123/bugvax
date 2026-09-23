import type { Match } from "./engine.js";
import { oldRange } from "./git.js";
import type { FixSample } from "./sample.js";
import { windows } from "./snippets.js";

export const GENERATE_SYSTEM = `You are bugvax, an expert in static analysis and ast-grep. You turn a real bug fix into an "antibody": an ast-grep rule that detects the same class of bug anywhere in the codebase, so the mistake cannot silently come back, whether a human or an AI coding agent writes it.

You receive one commit that fixed a bug: its message, the diff, and numbered excerpts of the code before and after the fix.

First decide whether the bug is a reusable pattern that can be recognized from syntax alone.
Good antibodies (generalizable = true) capture mistakes that can recur in other places, for example:
- an async call whose promise is not awaited; a missing return after sending a response
- a resource opened without being closed or without a context manager
- an API used the wrong way: wrong argument order, a missing required option, an unsafe or deprecated variant
- a value from a specific call used without the null/None/error check it needs
- mutable default arguments, loose equality, comparing to None with ==, swallowed exceptions
- a project-specific contract, e.g. "getUser() can return null", "db.transaction() callbacks must return the promise"
Not generalizable (generalizable = false): business-logic or algorithm changes, changed constants, strings, config values or UI copy, refactors, dependency bumps, test-only changes, and any fix where the buggy code cannot be told apart from correct code by its syntax. Do not force a rule; a wrong antibody is worse than none.

When generalizable, write an ast-grep rule that:
1. MATCHES the buggy code, at a node that overlaps the lines the fix changed (marked with ">" in the BEFORE excerpt).
2. Does NOT match the fixed code.
3. Generalizes: replace incidental names (local variables, argument values) with metavariables, but keep the names that carry the bug (library/API calls, the project function whose contract was violated).
4. Is precise. It must encode the condition that makes the code wrong (e.g. "commit() that is not awaited", not just "commit()"). Think about correct code that looks similar and exclude it.
5. Reports the node that needs to change (a call, statement or attribute), not a whole file or a huge block.

The message and note are shown to the developer or AI agent whose code triggers the rule: say concretely what is wrong and how to fix it. The id is short kebab-case naming the bug (e.g. "unawaited-transaction-commit").

Also write \`fix\`: an ast-grep fix template that rewrites the node your rule matches into the corrected code, the way the real fix did. It replaces the whole matched node and may use metavariables captured anywhere in the rule ($X, $$$ARGS), e.g. "await $DB.commit($$$ARGS)", "useEffect($FN, [])", "requests.$M($$$ARGS, timeout=10)". bugvax applies your template to the buggy code and keeps it only if the result matches the human fix, so leave \`fix\` as an empty string when the real fix is not a local rewrite of the matched node (for example it adds lines elsewhere, restructures a function, or depends on context).

${AST_GREP_REFERENCE()}`;

function AST_GREP_REFERENCE(): string {
  return `# ast-grep rule reference

\`rule_yaml\` must be YAML with a top-level \`rule:\` key and, optionally, \`constraints:\` and \`utils:\`. Do not include id, language, message, severity, note or fix; bugvax adds them (the fix template goes in the separate \`fix\` field).

## Atomic rules
pattern: "code with $META variables"   # parsed as code in the target language
  $X      matches exactly one AST node (UPPERCASE names). Using $X twice requires the same text.
  $$$ARGS matches zero or more nodes (arguments, statements, parameters).
  $_      matches one node without capturing it.
pattern:                               # when the snippet is not valid code on its own
  context: "class A { m() { $OBJ.save() } }"
  selector: call_expression            # the kind of the node inside context to match
kind: call_expression                  # a tree-sitter node kind
regex: "^use[A-Z]"                     # Rust regex over the node's full text

## Relational rules (combine with an atomic rule in the same object)
inside:   {kind: function_declaration, stopBy: end}   # some ANCESTOR matches
has:      {pattern: "await $_", stopBy: end}          # some DESCENDANT matches
follows:  {pattern: ..., stopBy: end}                 # some EARLIER sibling matches
precedes: {pattern: ..., stopBy: end}                 # some LATER sibling matches
IMPORTANT: without \`stopBy: end\` these only check the DIRECT parent / child / sibling.
Inside has/inside you may add \`field: <name>\` to restrict to a named child field (e.g. field: condition, field: value).

## Composite rules
all: [rule, ...]   any: [rule, ...]   not: rule   matches: <util-id>

## Constraints (top level, next to rule:) filter captured metavariables
constraints:
  M: {regex: "^(commit|flush)$"}

## Verified examples
# promise from commit() neither awaited nor returned
rule:
  pattern: $DB.commit()
  not:
    inside:
      any: [{kind: await_expression}, {kind: return_statement}]
# useEffect without a dependency array (argument count matters in patterns)
rule:
  pattern: useEffect($FN)
# <img> without alt
rule:
  kind: jsx_self_closing_element
  has: {field: name, regex: "^img$"}
  not: {has: {kind: jsx_attribute, has: {kind: property_identifier, regex: "^alt$"}}}
# Python mutable default argument
rule:
  kind: default_parameter
  has:
    field: value
    any: [{kind: list}, {kind: dictionary}]
# Python comparison to None with ==
rule:
  pattern: $X == None

All JavaScript and TypeScript files are parsed with the TSX grammar, so JS/TS rules use TSX node kinds.`;
}

export const GENERATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["generalizable", "reason", "id", "title", "message", "note", "severity", "rule_yaml", "fix"],
  properties: {
    generalizable: { type: "boolean", description: "false if this fix is not a reusable, syntactically detectable bug pattern" },
    reason: { type: "string", description: "One or two sentences: the bug class, or why it cannot be an antibody" },
    id: { type: "string", description: "kebab-case id naming the bug class; empty if not generalizable" },
    title: { type: "string", description: "Short human title of the bug class" },
    message: { type: "string", description: "One line shown at each match: what is wrong" },
    note: { type: "string", description: "1-3 sentences: why it is a bug and how to fix it" },
    severity: { type: "string", enum: ["error", "warning"] },
    rule_yaml: { type: "string", description: "YAML with top-level rule: (and optional constraints:, utils:)" },
    fix: { type: "string", description: "ast-grep fix template for the matched node, or empty string" },
  },
} as const;

export interface GenerateResponse {
  generalizable: boolean;
  reason: string;
  id: string;
  title: string;
  message: string;
  note: string;
  severity: "error" | "warning";
  rule_yaml: string;
  fix?: string;
}

export function isGenerateResponse(v: unknown): v is GenerateResponse {
  const o = v as Record<string, unknown>;
  return (
    !!o &&
    typeof o.generalizable === "boolean" &&
    typeof o.reason === "string" &&
    typeof o.id === "string" &&
    typeof o.message === "string" &&
    typeof o.rule_yaml === "string"
  );
}

export function generatePrompt(sample: FixSample): string {
  const parts: string[] = [];
  parts.push(`Language: ${sample.language.id} (${sample.language.label})`);
  parts.push(`Common node kinds: ${sample.language.kinds}`);
  if (sample.kind === "commit") parts.push(`Commit: ${sample.short}${sample.date ? ` (${sample.date.slice(0, 10)})` : ""}`);
  else parts.push("Source: uncommitted fix in the working tree");
  parts.push("", "## Fix description", sample.subject || "(no message)");
  if (sample.body) parts.push("", sample.body.slice(0, 2000));
  parts.push("", "## Diff", "```diff", sample.diff.trim(), "```");
  for (const f of sample.files) {
    parts.push("", `## ${f.path}, BEFORE the fix (lines changed by the fix are marked with >)`);
    parts.push("```", windows(f.before, f.hunks.map((h) => oldRange(h)), 25, 180), "```");
  }
  if (sample.testDiff.trim()) {
    parts.push("", "## Test changes in the same fix (context only; the rule must target source code)", "```diff", sample.testDiff.trim(), "```");
  }
  parts.push("", "Respond with the JSON object only.");
  return parts.join("\n");
}

export const REVIEW_SYSTEM = `You are a meticulous senior code reviewer. A static-analysis rule was learned from a real bug fix. You judge whether the places where the rule now fires contain the SAME bug, or whether the code there is actually fine.

Be strict and concrete: a location is a real bug only if the same fix would apply and the problem is not handled some other way (guarded earlier, awaited by the caller, intentionally different, dead code, test code that deliberately exercises the bad pattern).`;

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "real_bug", "reason"],
        properties: {
          index: { type: "integer" },
          real_bug: { type: "boolean" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

export interface ReviewResponse {
  verdicts: { index: number; real_bug: boolean; reason: string }[];
}

export function isReviewResponse(v: unknown): v is ReviewResponse {
  const o = v as Record<string, unknown>;
  return !!o && Array.isArray(o.verdicts);
}

export function reviewPrompt(sample: FixSample, rule: { id: string; message: string; note: string; ruleYaml: string }, locations: { match: Match; context: string }[]): string {
  const parts = [
    "## The original bug fix",
    sample.subject,
    "```diff",
    sample.diff.trim().slice(0, 6000),
    "```",
    "",
    `## The rule learned from it: ${rule.id}`,
    rule.message,
    rule.note,
    "```yaml",
    rule.ruleYaml.trim(),
    "```",
    "",
    `## Places in the current codebase where the rule fires (${locations.length})`,
  ];
  locations.forEach((l, i) => {
    parts.push("", `[${i + 1}] ${l.match.file}:${l.match.line}`, "```", l.context, "```");
  });
  parts.push("", "For every location give a verdict with its index. Respond with the JSON object only.");
  return parts.join("\n");
}

export function fixFeedback(problem: string): string {
  return [
    "The rule itself is accepted. Only the `fix` template failed the check against the real fix:",
    "",
    problem,
    "",
    "Return the JSON object again with rule_yaml unchanged and a corrected `fix`, or `fix` set to an empty string if a single template cannot express the real fix.",
  ].join("\n");
}

export function falsePositiveFeedback(fps: { match: Match; context: string; reason: string }[]): string {
  const parts = [
    "Your rule passed validation on the fix, but a reviewer found that it also flags CORRECT code in the current codebase (false positives):",
  ];
  for (const fp of fps.slice(0, 6)) {
    parts.push("", `${fp.match.file}:${fp.match.line}: ${fp.reason}`, "```", fp.context, "```");
  }
  parts.push("", "Refine the rule so it excludes these while still matching the original buggy code.");
  return parts.join("\n");
}
