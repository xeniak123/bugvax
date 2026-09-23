import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../src/core/git.js";
import { Store } from "../src/core/store.js";
import { run } from "../src/util/proc.js";
import { GOOD_RULE_YAML, INVOICES, makeRepo, REFUNDS_FIXED, type TestRepo } from "./helpers.js";

const ROOT = resolve(import.meta.dirname, "..");
const TSX = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const CLI = join(ROOT, "src", "cli.ts");

function cli(args: string[], cwd: string, input?: string) {
  return run(process.execPath, ["--import", TSX, CLI, ...args], { cwd, input, env: { ...process.env, NO_COLOR: "1" } });
}

async function repoWithAntibody(): Promise<TestRepo> {
  const repo = await makeRepo();
  await repo.commit({ "src/refunds.ts": REFUNDS_FIXED, "src/invoices.ts": INVOICES }, "shop");
  const store = new Store(repo.dir);
  await store.init();
  await store.save({
    id: "unawaited-db-commit",
    language: "tsx",
    severity: "error",
    message: "db.commit() is not awaited",
    note: "Await the commit so failures propagate.",
    ...YAML.parse(GOOD_RULE_YAML),
    metadata: { bugvax: { title: "t", learnedAt: "", source: { kind: "commit", commit: "abcdef1234", subject: "fix: await db commit", files: [] }, validation: {} } },
  });
  return repo;
}

describe("cli", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("scan reports the latent bug with its history", async () => {
    repo = await repoWithAntibody();
    const res = await cli(["scan"], repo.dir);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("src/invoices.ts:6");
    expect(res.stdout).toContain('learned from abcdef1 "fix: await db commit"');
  });

  it("check only flags changed lines, and the Claude Code hook feeds the bug back to the agent", async () => {
    repo = await repoWithAntibody();
    // The old latent bug in invoices.ts does not block an unrelated change…
    expect((await cli(["check"], repo.dir)).code).toBe(0);

    // …but re-introducing the bug in refunds.ts does.
    await repo.write({ "src/refunds.ts": REFUNDS_FIXED.replace("await db.commit();", "db.commit();") });
    const check = await cli(["check"], repo.dir);
    expect(check.code).toBe(1);
    expect(check.stdout).toContain("src/refunds.ts:6");
    expect(check.stdout).not.toContain("invoices");

    const hookInput = JSON.stringify({ cwd: repo.dir, tool_name: "Edit", tool_input: { file_path: join(repo.dir, "src", "refunds.ts") } });
    const hook = await cli(["check", "--hook", "claude-code"], repo.dir, hookInput);
    expect(hook.code).toBe(2);
    expect(hook.stderr).toContain("re-introduces 1 bug");
    expect(hook.stderr).toContain('fixed before in abcdef1 "fix: await db commit"');

    // Staged check sees the same thing.
    await git(repo.dir, ["add", "src/refunds.ts"]);
    expect((await cli(["check", "--staged"], repo.dir)).code).toBe(1);
  });

  it("init installs the Claude Code hook without clobbering existing settings", async () => {
    repo = await makeRepo();
    await repo.commit({ ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }) }, "settings");
    const res = await cli(["init", "--claude-code"], repo.dir);
    expect(res.code).toBe(0);
    const settings = JSON.parse(await readFile(join(repo.dir, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.allow).toEqual(["Bash(npm test)"]);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("npx -y bugvax check --hook claude-code");
    // Idempotent.
    await cli(["init", "--claude-code"], repo.dir);
    const again = JSON.parse(await readFile(join(repo.dir, ".claude", "settings.json"), "utf8"));
    expect(again.hooks.PostToolUse).toHaveLength(1);
  });
});
