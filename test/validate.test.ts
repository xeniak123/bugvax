import YAML from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuleDoc } from "../src/core/engine.js";
import { commitInfo } from "../src/core/git.js";
import { toCandidate } from "../src/core/mine.js";
import { sampleFromCandidate, sampleFromWorkingTree, type FixSample } from "../src/core/sample.js";
import { coveredBy, proveFix, validate } from "../src/core/validate.js";
import { GOOD_RULE_YAML, INVOICES, makeRepo, REFUNDS_BUGGY, REFUNDS_FIXED, unawaitedCommitRepo, type TestRepo } from "./helpers.js";

function rule(body: string, id = "unawaited-commit"): RuleDoc {
  return { id, language: "tsx", severity: "error", message: "commit() is not awaited", ...YAML.parse(body) };
}

describe("validation against real history", () => {
  let repo: TestRepo;
  let sample: FixSample;

  beforeAll(async () => {
    const r = await unawaitedCommitRepo();
    repo = r.repo;
    const cand = toCandidate(await commitInfo(repo.dir, r.fixSha))!;
    expect(cand).not.toBeNull();
    sample = await sampleFromCandidate(repo.dir, cand);
  });
  afterAll(() => repo.cleanup());

  it("builds a sample with the changed lines", () => {
    expect(sample.files.map((f) => f.path)).toEqual(["src/refunds.ts"]);
    expect(sample.files[0].hunks).toEqual([{ oldStart: 6, oldLines: 1, newStart: 6, newLines: 1 }]);
    expect(sample.diff).toContain("+  await db.commit();");
  });

  it("accepts a rule that catches the bug but not the fix, and finds the latent copy", async () => {
    const v = await validate(rule(GOOD_RULE_YAML), sample, repo.dir, { maxHeadMatches: 10 });
    expect(v.ok).toBe(true);
    expect(v.buggyHits).toHaveLength(1);
    expect(v.fixedHits).toHaveLength(0);
    expect(v.headMatches.map((m) => `${m.file}:${m.line}`)).toEqual(["src/invoices.ts:6"]);
  });

  it("rejects a rule that still matches the fixed code", async () => {
    const v = await validate(rule("rule:\n  pattern: $DB.commit()\n"), sample, repo.dir, { maxHeadMatches: 10 });
    expect(v.ok).toBe(false);
    expect(v.feedback).toMatch(/still matches the FIXED code/);
  });

  it("rejects a rule that misses the buggy lines", async () => {
    const v = await validate(rule("rule:\n  pattern: $DB.rollback()\n"), sample, repo.dir, { maxHeadMatches: 10 });
    expect(v.ok).toBe(false);
    expect(v.feedback).toMatch(/does NOT match the buggy code/);
    expect(v.feedback).toContain(">");
  });

  it("rejects a rule that is too broad", async () => {
    const broad = "rule:\n  kind: identifier\n  not:\n    inside:\n      kind: await_expression\n      stopBy: end\n";
    const v = await validate(rule(broad), sample, repo.dir, { maxHeadMatches: 3 });
    expect(v.ok).toBe(false);
  });

  it("explains invalid rules", async () => {
    const v = await validate(rule("rule:\n  kind: no_such_kind\n"), sample, repo.dir, { maxHeadMatches: 10 });
    expect(v.ok).toBe(false);
    expect(v.compileError).toMatch(/invalid/i);
    expect(v.feedback).toMatch(/tree-sitter node kinds/);
  });

  it("detects that an existing antibody already covers a fix", async () => {
    expect(await coveredBy([rule(GOOD_RULE_YAML)], sample)).toBe("unawaited-commit");
    expect(await coveredBy([rule("rule:\n  pattern: $DB.rollback()\n", "other")], sample)).toBeNull();
  });
});

describe("proving auto-fixes on history", () => {
  let repo: TestRepo;
  let sample: FixSample;

  beforeAll(async () => {
    const r = await unawaitedCommitRepo();
    repo = r.repo;
    sample = await sampleFromCandidate(repo.dir, toCandidate(await commitInfo(repo.dir, r.fixSha))!);
  });
  afterAll(() => repo.cleanup());

  async function prove(fix: string) {
    const withFix = { ...rule(GOOD_RULE_YAML), fix };
    const v = await validate(withFix, sample, repo.dir, { maxHeadMatches: 10 });
    expect(v.ok).toBe(true);
    return proveFix(withFix, sample, v.buggyHits);
  }

  it("accepts a template that reproduces the human fix", async () => {
    expect(await prove("await $DB.commit()")).toMatchObject({ ok: true, fixed: 1 });
  });

  it("rejects a template that removes the match but differs from the human fix", async () => {
    const proof = await prove("$DB.commit().catch(() => {})");
    expect(proof.ok).toBe(false);
    expect(proof.feedback).toContain("real fix looks different");
  });

  it("rejects a fix that would need more than a local rewrite (Python mutable default)", async () => {
    const py = await makeRepo();
    try {
      const before = "def add_item(cart, item, tags=[]):\n    tags.append(item.category)\n    cart.tags = tags\n    return cart\n";
      const after = "def add_item(cart, item, tags=None):\n    if tags is None:\n        tags = []\n    tags.append(item.category)\n    cart.tags = tags\n    return cart\n";
      await py.commit({ "app/cart.py": before }, "cart");
      const sha = await py.commit({ "app/cart.py": after }, "fix: shared default tags list");
      const pySample = await sampleFromCandidate(py.dir, toCandidate(await commitInfo(py.dir, sha))!);
      const mutable: RuleDoc = {
        id: "mutable-default",
        language: "python",
        severity: "error",
        message: "mutable default",
        rule: { kind: "default_parameter", all: [{ has: { field: "name", pattern: "$NAME" } }, { has: { field: "value", kind: "list" } }] },
        fix: "$NAME=None",
      };
      const v = await validate(mutable, pySample, py.dir, { maxHeadMatches: 10 });
      expect(v.ok).toBe(true);
      const proof = await proveFix(mutable, pySample, v.buggyHits);
      expect(proof.ok).toBe(false);
      expect(proof.feedback).toContain("if tags is None");
    } finally {
      await py.cleanup();
    }
  });
});

describe("learning from an uncommitted fix", () => {
  it("uses HEAD as the buggy version and the working tree as the fix", async () => {
    const repo = await makeRepo();
    try {
      await repo.commit({ "src/refunds.ts": REFUNDS_BUGGY, "src/invoices.ts": INVOICES }, "shop");
      expect(await sampleFromWorkingTree(repo.dir, "nothing yet")).toBeNull();
      await repo.write({ "src/refunds.ts": REFUNDS_FIXED });
      const sample = (await sampleFromWorkingTree(repo.dir, "await the commit"))!;
      expect(sample.kind).toBe("working-tree");
      expect(sample.subject).toBe("await the commit");
      expect(sample.files.map((f) => f.path)).toEqual(["src/refunds.ts"]);
      const v = await validate(rule(GOOD_RULE_YAML), sample, repo.dir, { maxHeadMatches: 10 });
      expect(v.ok).toBe(true);
      expect(v.headMatches.map((m) => `${m.file}:${m.line}`)).toEqual(["src/invoices.ts:6"]);
    } finally {
      await repo.cleanup();
    }
  });
});
