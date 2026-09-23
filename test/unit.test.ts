import { describe, expect, it } from "vitest";
import { newRange, oldRange, overlaps, parseHunks, parseLog } from "../src/core/git.js";
import { isTestFile, languageOf } from "../src/core/languages.js";
import { buildRule, slug } from "../src/core/learner.js";
import { findCandidates, scoreMessage } from "../src/core/mine.js";
import { mergeRanges, windows } from "../src/core/snippets.js";
import { classifyError, extractJSON } from "../src/llm/types.js";
import { patchFiles } from "../src/commands/check.js";
import type { FixSample } from "../src/core/sample.js";

describe("git parsing", () => {
  it("parses zero-context hunks, including pure insertions and deletions", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -6 +6 @@ export async function refund() {",
      "@@ -10,0 +11,2 @@",
      "@@ -20,3 +22,0 @@",
    ].join("\n");
    const hunks = parseHunks(diff).get("src/a.ts")!;
    expect(hunks).toEqual([
      { oldStart: 6, oldLines: 1, newStart: 6, newLines: 1 },
      { oldStart: 10, oldLines: 0, newStart: 11, newLines: 2 },
      { oldStart: 20, oldLines: 3, newStart: 22, newLines: 0 },
    ]);
    expect(oldRange(hunks[1])).toEqual([10, 11]);
    expect(newRange(hunks[2])).toEqual([22, 23]);
    expect(overlaps([5, 7], [6, 6])).toBe(true);
    expect(overlaps([1, 5], [6, 9])).toBe(false);
  });

  it("parses git log records with numstat", () => {
    const RS = "\x1e";
    const US = "\x1f";
    const out = `${RS}abc123${US}abc${US}2026-01-02T03:04:05+00:00${US}fix: thing${US}body line${US}\n\n3\t1\tsrc/a.ts\n-\t-\timg.png\n`;
    const [c] = parseLog(out);
    expect(c.subject).toBe("fix: thing");
    expect(c.body).toBe("body line");
    expect(c.files).toEqual([{ path: "src/a.ts", added: 3, deleted: 1 }]);
  });
});

describe("bug-fix detection", () => {
  it("scores real fixes and rejects chores", () => {
    expect(scoreMessage("fix: await db commit in refunds", "")).toBeGreaterThanOrEqual(3);
    expect(scoreMessage("Fix crash when cart is empty", "")).toBeGreaterThanOrEqual(3);
    expect(scoreMessage("Handle null user in checkout", "")).toBeGreaterThanOrEqual(1.5);
    expect(scoreMessage("naprawa błędu przy logowaniu", "")).toBeGreaterThanOrEqual(3);
    expect(scoreMessage("fix typo in README", "")).toBe(0);
    expect(scoreMessage("fix lint errors", "")).toBe(0);
    expect(scoreMessage("chore(deps): bump react", "")).toBe(0);
    expect(scoreMessage("docs: fix link", "")).toBe(0);
    expect(scoreMessage("Revert \"fix: thing\"", "")).toBe(0);
    expect(scoreMessage("add dark mode", "")).toBeLessThan(1.5);
  });

  it("keeps small source fixes and drops test-only or huge commits", () => {
    const base = { short: "x", date: "2026-01-01", body: "" };
    const cands = findCandidates([
      { ...base, sha: "1", subject: "fix: null check", files: [{ path: "src/a.ts", added: 2, deleted: 1 }, { path: "src/a.test.ts", added: 10, deleted: 0 }] },
      { ...base, sha: "2", subject: "fix: flaky assertion", files: [{ path: "test/a.test.ts", added: 2, deleted: 1 }] },
      { ...base, sha: "3", subject: "fix: rewrite parser", files: [{ path: "src/p.py", added: 300, deleted: 200 }] },
      { ...base, sha: "4", subject: "fix: styles", files: [{ path: "src/a.css", added: 2, deleted: 1 }] },
    ]);
    expect(cands.map((c) => c.commit.sha)).toEqual(["1"]);
    expect(cands[0].testFiles.map((f) => f.path)).toEqual(["src/a.test.ts"]);
  });

  it("recognizes languages and test files", () => {
    expect(languageOf("src/App.jsx")?.id).toBe("tsx");
    expect(languageOf("pkg/x.go")?.id).toBe("go");
    expect(languageOf("style.css")).toBeUndefined();
    expect(isTestFile("src/__tests__/a.ts")).toBe(true);
    expect(isTestFile("app/test_models.py")).toBe(true);
    expect(isTestFile("pkg/handler_test.go")).toBe(true);
    expect(isTestFile("src/contest.ts")).toBe(false);
  });
});

describe("snippets", () => {
  it("merges ranges and marks changed lines", () => {
    expect(mergeRanges([[5, 7], [1, 2], [8, 9]])).toEqual([[1, 2], [5, 9]]);
    const out = windows("a\nb\nc\nd\ne", [[3, 3]], 1);
    expect(out).toBe("  2| b\n> 3| c\n  4| d");
  });
});

describe("agent hooks", () => {
  it("reads the files touched by a Codex apply_patch", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-x",
      "+y",
      "*** Add File: src/new.py",
      "+print(1)",
      "*** Update File: src/old.ts",
      "*** Move to: src/moved.ts",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n");
    expect(patchFiles(patch)).toEqual(["src/a.ts", "src/new.py", "src/old.ts", "src/moved.ts"]);
  });
});

describe("backend errors", () => {
  it("treats usage limits and auth problems as fatal, outages as transient", () => {
    expect(classifyError("You've hit your session limit · resets 6:50pm (Europe/Warsaw)")).toBe("fatal");
    expect(classifyError("Claude AI usage limit reached|1758650000")).toBe("fatal");
    expect(classifyError("Your credit balance is too low to access the Anthropic API.")).toBe("fatal");
    expect(classifyError("Invalid API key · Please run /login")).toBe("fatal");
    expect(classifyError("API Error: 529 Overloaded")).toBe("transient");
    expect(classifyError("request timed out")).toBe("transient");
    expect(classifyError("The model declined to analyze this change.")).toBe("model");
  });
});

describe("model output handling", () => {
  it("extracts JSON from fenced or chatty output", () => {
    expect(extractJSON('{"a":1}')).toEqual({ a: 1 });
    expect(extractJSON('Here you go:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJSON('Sure! {"a":3} Hope that helps')).toEqual({ a: 3 });
  });

  it("builds a rule document and wraps bare rule bodies", () => {
    const sample = { kind: "commit", sha: "abc", subject: "fix", files: [{ path: "a.ts" }], language: { id: "tsx" } } as unknown as FixSample;
    const res = { generalizable: true, reason: "", id: "Unawaited Commit!", title: "t", message: "m", note: "n", severity: "error" as const, rule_yaml: "pattern: $X.commit()" };
    const built = buildRule(res, sample, 1);
    expect(built.error).toBeUndefined();
    expect(built.rule?.id).toBe("unawaited-commit");
    expect(built.rule?.rule).toEqual({ pattern: "$X.commit()" });
    expect(buildRule({ ...res, rule_yaml: "- nope" }, sample, 1).error).toMatch(/mapping/);
    expect(slug("  ")).toBe("antibody");
  });
});
