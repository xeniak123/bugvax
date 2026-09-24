import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../src/core/git.js";
import { run } from "../src/util/proc.js";
import { INVOICES, makeRepo, REFUNDS_FIXED, repoWithAntibody, type TestRepo } from "./helpers.js";

const ROOT = resolve(import.meta.dirname, "..");
const TSX = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const CLI = join(ROOT, "src", "cli.ts");
const REINTRODUCED = REFUNDS_FIXED.replace("await db.commit();", "db.commit();");
const WIP = "export async function f(db) {\n  db.commit();\n}\n";

function cli(args: string[], cwd: string, input?: string, env: Record<string, string> = {}) {
  return run(process.execPath, ["--import", TSX, CLI, ...args], { cwd, input, env: { ...process.env, NO_COLOR: "1", GITHUB_ACTIONS: "false", ...env } });
}

let sessions = 0;
const newSession = () => `test-${process.pid}-${Date.now()}-${sessions++}`;

describe("agent sessions", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("briefs the agent at session start and prints nothing without antibodies", async () => {
    repo = await repoWithAntibody("await $DB.commit()");
    const res = await cli(["context", "--hook", "claude-code"], repo.dir, JSON.stringify({ session_id: newSession(), cwd: repo.dir, source: "startup" }));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("[unawaited-db-commit] JavaScript/TypeScript: db.commit() is not awaited");
    expect(res.stdout).toContain('fixed before in abcdef1 "fix: await db commit"');
    expect(res.stdout).toContain("src/invoices.ts:6 [unawaited-db-commit] `db.commit();` (proven auto-fix");
    expect(res.stdout).toContain("Every edit you make is checked");
    // Without --hook it is a plain briefing (e.g. for AGENTS.md), with no claim about hooks.
    expect((await cli(["context"], repo.dir)).stdout).not.toContain("Every edit you make is checked");

    const empty = await makeRepo();
    try {
      await empty.commit({ "a.ts": "export const a = 1;\n" }, "init");
      const none = await cli(["context", "--hook", "claude-code"], empty.dir, JSON.stringify({ session_id: newSession(), cwd: empty.dir }));
      expect(none.code).toBe(0);
      expect(none.stdout).toBe("");
    } finally {
      await empty.cleanup();
    }
  });

  it("the Stop hook blocks until the agent's own changes are clean, never for the user's earlier work", async () => {
    repo = await repoWithAntibody();
    await repo.write({ "src/wip.ts": WIP }); // the user's uncommitted work, before the session
    const session = { session_id: newSession(), cwd: repo.dir };
    await cli(["context", "--hook", "claude-code"], repo.dir, JSON.stringify(session));
    const stop = (extra: Record<string, unknown> = {}) =>
      cli(["check", "--hook", "claude-code-stop"], repo.dir, JSON.stringify({ ...session, hook_event_name: "Stop", stop_hook_active: false, ...extra }));

    expect((await stop()).code).toBe(0); // the agent changed nothing

    await repo.write({ "src/refunds.ts": REINTRODUCED });
    const first = await stop();
    expect(first.code).toBe(2);
    expect(first.stderr).toContain("before you finish");
    expect(first.stderr).toContain("src/refunds.ts:6");
    expect(first.stderr).not.toContain("wip.ts");
    // The agent insists (e.g. it thinks it is a false positive): blocked once more, then let go.
    expect((await stop({ stop_hook_active: true })).code).toBe(2);
    expect((await stop({ stop_hook_active: true })).code).toBe(0);

    // Without a session-start snapshot every uncommitted change counts.
    const other = await cli(["check", "--hook", "claude-code-stop"], repo.dir, JSON.stringify({ session_id: newSession(), cwd: repo.dir }));
    expect(other.code).toBe(2);
    expect(other.stderr).toContain("src/wip.ts");
  });

  it("Cursor's stop hook checks only the files the agent edited", async () => {
    repo = await repoWithAntibody();
    const conv = { conversation_id: newSession(), workspace_roots: [repo.dir] };
    await repo.write({ "src/wip.ts": WIP });
    // A question that edits nothing: no follow-up, although the user's wip.ts has the bug.
    expect(JSON.parse((await cli(["check", "--hook", "cursor"], repo.dir, JSON.stringify({ ...conv, status: "completed", loop_count: 0 }))).stdout)).toEqual({});

    await repo.write({ "src/refunds.ts": REINTRODUCED });
    const edit = await cli(["check", "--hook", "cursor-edit"], repo.dir, JSON.stringify({ ...conv, file_path: join(repo.dir, "src", "refunds.ts"), edits: [] }));
    expect(edit.code).toBe(0);
    expect(edit.stdout).toBe("");
    const stop = await cli(["check", "--hook", "cursor"], repo.dir, JSON.stringify({ ...conv, status: "completed", loop_count: 0 }));
    const msg = JSON.parse(stop.stdout).followup_message as string;
    expect(msg).toContain("src/refunds.ts:6");
    expect(msg).not.toContain("wip.ts");
  });

  it("works when the session runs in a folder that holds the repository", async () => {
    repo = await repoWithAntibody("await $DB.commit()");
    const parent = await mkdtemp(join(tmpdir(), "bugvax-parent-"));
    try {
      const shop = join(parent, "shop");
      await cp(repo.dir, shop, { recursive: true });
      const session = { session_id: newSession(), cwd: parent };
      const ctx = await cli(["context", "--hook", "claude-code"], parent, JSON.stringify(session));
      expect(ctx.stdout).toContain("the repository in shop/");
      expect(ctx.stdout).toContain("shop/src/invoices.ts:6 [unawaited-db-commit]");
      await writeFile(join(shop, "src", "refunds.ts"), REINTRODUCED);
      const edit = await cli(["check", "--hook", "claude-code"], parent, JSON.stringify({ ...session, tool_name: "Edit", tool_input: { file_path: join(shop, "src", "refunds.ts") } }));
      expect(edit.code).toBe(2);
      expect(edit.stderr).toContain("shop/src/refunds.ts:6");
      const stop = await cli(["check", "--hook", "claude-code-stop"], parent, JSON.stringify(session));
      expect(stop.code).toBe(2);
      expect(stop.stderr).toContain("shop/src/refunds.ts:6");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("init --claude-code installs the briefing, both checks and the skill", async () => {
    repo = await makeRepo();
    await repo.commit({ "README.md": "x\n" }, "init");
    expect((await cli(["init", "--claude-code", "--cursor"], repo.dir)).code).toBe(0);
    const settings = JSON.parse(await readFile(join(repo.dir, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("npx -y --loglevel=error bugvax context --hook claude-code");
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("npx -y --loglevel=error bugvax check --hook claude-code-stop");
    expect(await readFile(join(repo.dir, ".claude", "skills", "bugvax", "SKILL.md"), "utf8")).toContain("name: bugvax");
    const cursor = JSON.parse(await readFile(join(repo.dir, ".cursor", "hooks.json"), "utf8"));
    expect(cursor.hooks.afterFileEdit[0].command).toBe("npx -y --loglevel=error bugvax check --hook cursor-edit");
    await cli(["init", "--claude-code", "--cursor"], repo.dir);
    const again = JSON.parse(await readFile(join(repo.dir, ".claude", "settings.json"), "utf8"));
    expect([again.hooks.SessionStart, again.hooks.PostToolUse, again.hooks.Stop].map((h) => h.length)).toEqual([1, 1, 1]);
  });
});

describe("check and scan edge cases", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("catches a bug re-introduced by deleting a line", async () => {
    repo = await repoWithAntibody();
    const split = REFUNDS_FIXED.replace("  await db.commit();", "  await\n    db.commit();");
    await repo.commit({ "src/refunds.ts": split }, "split the await");
    expect((await cli(["check"], repo.dir)).code).toBe(0);
    await repo.write({ "src/refunds.ts": split.replace("  await\n", "") });
    const res = await cli(["check", "--json"], repo.dir);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).map((m: { file: string }) => m.file)).toEqual(["src/refunds.ts"]);
  });

  it("honours exclude for explicit paths, hooks and CI", async () => {
    repo = await repoWithAntibody();
    const config = join(repo.dir, ".bugvax", "config.json");
    await writeFile(config, JSON.stringify({ ...JSON.parse(await readFile(config, "utf8")), exclude: ["**/legacy/**"] }));
    await repo.write({ "src/legacy/old.ts": WIP });
    expect(JSON.parse((await cli(["check", "--json"], repo.dir)).stdout)).toEqual([]);
    expect((await cli(["check", "src/legacy/old.ts"], repo.dir)).code).toBe(0);
    const hook = await cli(["check", "--hook", "claude-code"], repo.dir, JSON.stringify({ cwd: repo.dir, tool_input: { file_path: join(repo.dir, "src", "legacy", "old.ts") } }));
    expect(hook.code).toBe(0);
    expect((await cli(["scan", "src/legacy"], repo.dir)).code).toBe(0);
  });

  it("ignores the user's diff settings", async () => {
    repo = await repoWithAntibody();
    await git(repo.dir, ["config", "diff.mnemonicPrefix", "true"]);
    await git(repo.dir, ["config", "diff.noprefix", "true"]);
    await repo.write({ "src/refunds.ts": REINTRODUCED });
    expect((await cli(["check"], repo.dir)).code).toBe(1);
    await git(repo.dir, ["add", "-A"]);
    expect((await cli(["check", "--staged"], repo.dir)).code).toBe(1);
  });

  it("checks files with non-ASCII names", async () => {
    repo = await repoWithAntibody();
    await repo.commit({ "src/zamówienie.ts": REFUNDS_FIXED }, "orders");
    await repo.write({ "src/zamówienie.ts": REINTRODUCED, "src/płatność.ts": WIP });
    const files = JSON.parse((await cli(["check", "--json"], repo.dir)).stdout).map((m: { file: string }) => m.file);
    expect(files.sort()).toEqual(["src/płatność.ts", "src/zamówienie.ts"]);
    await git(repo.dir, ["add", "-A"]);
    expect((await cli(["check", "--staged", "--json"], repo.dir)).stdout).toContain("zamówienie.ts");
  });

  it("resolves scan paths from the current directory and rejects missing ones", async () => {
    repo = await repoWithAntibody();
    const src = join(repo.dir, "src");
    const res = await cli(["scan", "invoices.ts"], src);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("src/invoices.ts:6");
    const missing = await cli(["scan", "nope.ts"], src);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("does not exist");
  });

  it("prints JSON even without antibodies", async () => {
    repo = await makeRepo();
    await repo.commit({ "a.ts": "export const a = 1;\n" }, "init");
    expect((await cli(["check", "--json"], repo.dir)).stdout.trim()).toBe("[]");
    expect(JSON.parse((await cli(["fix", "--json"], repo.dir)).stdout)).toEqual({ applied: [], remaining: [] });
  });

  it("fails on an unknown vaccine pack without touching the repository", async () => {
    repo = await makeRepo();
    await repo.commit({ "a.ts": "export const a = 1;\n" }, "init");
    const res = await cli(["vaccinate", "startr"], repo.dir);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('unknown vaccine pack "startr"');
    expect(existsSync(join(repo.dir, ".bugvax"))).toBe(false);
  });

  it("learn --dry-run never calls the model, also with --working", async () => {
    repo = await makeRepo();
    await repo.commit({ "src/invoices.ts": INVOICES }, "init");
    await repo.write({ "src/invoices.ts": INVOICES.replace("  db.commit();", "  await db.commit();") });
    const res = await cli(["learn", "--working", "-m", "await the commit", "--dry-run", "--provider", "claude-code"], repo.dir, undefined, {
      BUGVAX_CLAUDE_BIN: join(repo.dir, "no-such-claude"),
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("working tree  await the commit");
    expect(existsSync(join(repo.dir, ".bugvax"))).toBe(false);
  });
});
