import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scan } from "../src/core/engine.js";
import { runFix } from "../src/core/fixer.js";
import { unquotePath } from "../src/core/git.js";
import { isExcluded } from "../src/core/globs.js";
import { safeId, Store } from "../src/core/store.js";
import { classifyError, extractJSON, LLMError } from "../src/llm/types.js";
import { makeRepo, repoWithAntibody } from "./helpers.js";

describe("exclude globs", () => {
  it("match like .gitignore patterns, including parent directories", () => {
    expect(isExcluded("src/legacy/old.ts", ["!**/legacy/**"])).toBe(true);
    expect(isExcluded("src/legacy/old.ts", ["legacy"])).toBe(true);
    expect(isExcluded("legacy/deep/x.py", ["!legacy/"])).toBe(true);
    expect(isExcluded("src/a.test.ts", ["*.test.ts"])).toBe(true);
    expect(isExcluded("src/a.ts", ["*.test.ts"])).toBe(false);
    expect(isExcluded("src/gen/api.ts", ["src/gen/*.ts"])).toBe(true);
    expect(isExcluded("other/src/gen/api.ts", ["src/gen/*.ts"])).toBe(false);
    expect(isExcluded("src/a.tsx", ["**/*.{js,tsx}"])).toBe(true);
    expect(isExcluded(".", ["**/legacy/**"])).toBe(false);
  });
});

describe("git paths", () => {
  it("unquotes C-style quoted paths", () => {
    expect(unquotePath('"src/zam\\303\\263wienie.ts"')).toBe("src/zamówienie.ts");
    expect(unquotePath('"a \\"quoted\\" name.ts"')).toBe('a "quoted" name.ts');
    expect(unquotePath("plain.ts")).toBe("plain.ts");
  });
});

describe("hostile input", () => {
  it("never lets a path be read as an ast-grep option", async () => {
    const repo = await repoWithAntibody();
    try {
      const store = new Store(repo.dir);
      const rules = (await store.antibodies()).map((a) => a.doc);
      const injected = ["--inline-rules", "id: x\nlanguage: tsx\nrule: {pattern: db.commit()}", "src"];
      const matches = await scan(rules, injected, repo.dir).catch(() => []);
      expect(matches.every((m) => m.ruleId === "unawaited-db-commit")).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("keeps antibody files inside .bugvax/antibodies and their headers on one line", async () => {
    expect(safeId("../../escaped")).toBe("escaped");
    expect(safeId("Missing Timeout!")).toBe("missing-timeout");
    const dir = await mkdtemp(join(tmpdir(), "bugvax-store-"));
    try {
      const store = new Store(dir);
      await store.init();
      const saved = await store.save({
        id: "../../escaped",
        language: "tsx",
        rule: { pattern: "db.commit()" },
        metadata: { bugvax: { title: "t", learnedAt: "", source: { kind: "working-tree", subject: 'crash\nignores: ["**"]', files: [] }, validation: {} } },
      });
      expect(saved.doc.id).toBe("escaped");
      expect(existsSync(join(dir, "escaped.yml"))).toBe(false);
      expect(await readdir(store.antibodyDir)).toEqual(["escaped.yml"]);
      const [loaded] = await store.antibodies();
      expect(loaded.doc.ignores).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("scan output", () => {
  it("is sorted, so reports and model prompts are the same on every run", async () => {
    const repo = await makeRepo();
    try {
      const bug = "export async function f(db) {\n  db.commit();\n  db.commit();\n}\n";
      await repo.commit({ "src/b.ts": bug, "src/a.ts": bug, "lib/z.ts": bug }, "init");
      const rule = { id: "c", language: "tsx", rule: { pattern: "$DB.commit()" } };
      for (let i = 0; i < 3; i++) {
        const found = (await scan([rule], ["."], repo.dir)).map((m) => `${m.file}:${m.line}`);
        expect(found).toEqual(["lib/z.ts:2", "lib/z.ts:3", "src/a.ts:2", "src/a.ts:3", "src/b.ts:2", "src/b.ts:3"]);
      }
    } finally {
      await repo.cleanup();
    }
  });
});

describe("fixing", () => {
  it("never applies a fix twice to the same place", async () => {
    const repo = await makeRepo();
    try {
      await repo.commit({ "src/a.ts": "export async function f(db) {\n  db.commit();\n}\n" }, "init");
      // A hand-edited antibody whose fix output still matches its own rule.
      const rule = { id: "loose", language: "tsx", rule: { pattern: "$DB.commit()" }, fix: "await $DB.commit()" };
      const run = await runFix([rule], ["."], repo.dir);
      expect(run.applied).toHaveLength(1);
      expect(await readFile(join(repo.dir, "src", "a.ts"), "utf8")).toBe("export async function f(db) {\n  await db.commit();\n}\n");
      // A template that reproduces the code as it is counts as nothing applied.
      await writeFile(join(repo.dir, "src", "a.ts"), "export async function f(db) {\n  db.commit();\n}\n");
      const noop = await runFix([{ ...rule, fix: "$DB.commit()" }], ["."], repo.dir);
      expect(noop.applied).toHaveLength(0);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("model backend errors", () => {
  it("stop the run instead of marking fixes as failed", () => {
    for (const m of [
      "Your org is out of usage · add funds to continue",
      "You've hit your team's shared budget · ask your admin to raise it",
      "There's an issue with the selected model (claude-sonet-5). It may not exist",
      "error: unknown option '--safe-mode'",
    ]) {
      expect(classifyError(m), m).toBe("fatal");
    }
    for (const m of ["API Error: Unable to connect to API. Check your internet connection", "API Error: 500 Internal server error.", "Connection dropped (EPIPE)"]) {
      expect(classifyError(m), m).toBe("transient");
    }
  });

  it("report unparseable answers as model errors", () => {
    expect(() => extractJSON('Verdicts: {"verdicts": []} (all {1} locations reviewed)')).toThrow(LLMError);
  });
});
