import { rmSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

function cli(args: string[], cwd: string, input?: string, env: Record<string, string> = {}) {
  return run(process.execPath, ["--import", TSX, CLI, ...args], { cwd, input, env: { ...process.env, NO_COLOR: "1", GITHUB_ACTIONS: "false", ...env } });
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
    expect(res.stdout).not.toContain("::error");

    const inActions = await cli(["scan"], repo.dir, undefined, { GITHUB_ACTIONS: "true" });
    expect(inActions.stdout).toContain("::error file=src/invoices.ts,line=6,endLine=6,title=bugvax%3A unawaited-db-commit::db.commit() is not awaited%0A");
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

  it("the hook still works when the agent reports paths through a symlink", async () => {
    // e.g. macOS /var -> /private/var, Windows 8.3 short names, projects opened via a link
    repo = await repoWithAntibody();
    await repo.write({ "src/refunds.ts": REFUNDS_FIXED.replace("await db.commit();", "db.commit();") });
    const link = join(tmpdir(), `bugvax-link-${process.pid}-${Date.now()}`);
    symlinkSync(repo.dir, link, process.platform === "win32" ? "junction" : "dir");
    try {
      const input = JSON.stringify({ cwd: link, tool_name: "Edit", tool_input: { file_path: join(link, "src", "refunds.ts") } });
      const hook = await cli(["check", "--hook", "claude-code"], link, input);
      expect(hook.stderr).toContain("src/refunds.ts:6");
      expect(hook.code).toBe(2);
      const outside = JSON.stringify({ cwd: link, tool_name: "Edit", tool_input: { file_path: join(tmpdir(), "elsewhere.ts") } });
      expect((await cli(["check", "--hook", "claude-code"], link, outside)).code).toBe(0);
    } finally {
      rmSync(link);
    }
  });

  it("speaks each agent's hook protocol (Gemini CLI, Codex, Cursor)", async () => {
    repo = await repoWithAntibody();
    const refunds = join(repo.dir, "src", "refunds.ts");

    // Clean edits produce no complaint.
    const cleanGemini = await cli(["check", "--hook", "gemini"], repo.dir, JSON.stringify({ cwd: repo.dir, tool_name: "write_file", tool_input: { file_path: refunds } }));
    expect(JSON.parse(cleanGemini.stdout)).toEqual({});
    const cleanCursor = await cli(["check", "--hook", "cursor"], repo.dir, JSON.stringify({ workspace_roots: [repo.dir] }));
    expect(JSON.parse(cleanCursor.stdout)).toEqual({});

    await repo.write({ "src/refunds.ts": REFUNDS_FIXED.replace("await db.commit();", "db.commit();") });

    const gemini = await cli(["check", "--hook", "gemini"], repo.dir, JSON.stringify({ cwd: repo.dir, tool_name: "replace", tool_input: { file_path: refunds } }));
    expect(gemini.code).toBe(0);
    const g = JSON.parse(gemini.stdout);
    expect(g.hookSpecificOutput.hookEventName).toBe("AfterTool");
    expect(g.hookSpecificOutput.additionalContext).toContain("src/refunds.ts:6  [unawaited-db-commit]");

    const patch = "*** Begin Patch\n*** Update File: src/refunds.ts\n@@\n-  await db.commit();\n+  db.commit();\n*** End Patch";
    const codex = await cli(["check", "--hook", "codex"], repo.dir, JSON.stringify({ cwd: repo.dir, tool_name: "apply_patch", tool_input: { command: patch } }));
    expect(codex.code).toBe(0);
    const c = JSON.parse(codex.stdout);
    expect(c.decision).toBe("block");
    expect(c.reason).toContain("fixed before in abcdef1");

    const cursor = await cli(["check", "--hook", "cursor"], repo.dir, JSON.stringify({ workspace_roots: [repo.dir], status: "completed" }));
    expect(JSON.parse(cursor.stdout).followup_message).toContain("your changes re-introduce 1 bug");
    // The untouched latent bug in invoices.ts is not blamed on the agent.
    expect(cursor.stdout).not.toContain("invoices");
  });

  it("fix previews and then applies proven fixes", async () => {
    repo = await repoWithAntibody("await $DB.commit()");
    const preview = await cli(["fix", "--dry-run"], repo.dir);
    expect(preview.code).toBe(1);
    expect(preview.stdout).toContain("- db.commit()");
    expect(preview.stdout).toContain("+ await db.commit()");
    expect(await readFile(join(repo.dir, "src", "invoices.ts"), "utf8")).toBe(INVOICES);

    const res = await cli(["fix"], repo.dir);
    expect(res.stdout).toContain("fixed 1 bug in 1 file");
    expect(res.code).toBe(0);
    expect(await readFile(join(repo.dir, "src", "invoices.ts"), "utf8")).toBe(INVOICES.replace("  db.commit();", "  await db.commit();"));
    expect((await cli(["scan"], repo.dir)).code).toBe(0);
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

  it("exports antibodies as a vaccine pack and vaccinates another repository with it", async () => {
    const source = await repoWithAntibody("await $DB.commit()");
    const vaccines = await mkdtemp(join(tmpdir(), "bugvax-vaccines-"));
    try {
      const exported = await cli(
        ["export-pack", "shop", "--out", join(vaccines, "shop"), "--repo", "https://github.com/example/shop", "--description", "Shop bugs", "--fixes", "7"],
        source.dir,
      );
      expect(exported.stdout).toContain("Exported 1 antibody");
      const pack = JSON.parse(await readFile(join(vaccines, "shop", "pack.json"), "utf8"));
      expect(pack).toMatchObject({ name: "shop", languages: ["tsx"], sources: [{ repo: "https://github.com/example/shop", fixesAnalyzed: 7 }] });

      repo = await makeRepo();
      await repo.commit({ "src/invoices.ts": INVOICES }, "someone else's shop");
      const env = { BUGVAX_VACCINES_DIR: vaccines };
      expect((await cli(["vaccinate"], repo.dir, undefined, env)).stdout).toContain("learned from: example/shop");
      const res = await cli(["vaccinate", "shop"], repo.dir, undefined, env);
      expect(res.stdout).toContain("shop: 1 new antibody");
      expect(res.stdout).toContain("1 finding in your code already");
      expect((await cli(["vaccinate", "shop"], repo.dir, undefined, env)).stdout).toContain("1 already present");

      const scan = await cli(["scan"], repo.dir);
      expect(scan.stdout).toContain("💉 shop vaccine");
      expect(scan.stdout).toContain("src/invoices.ts:6");
      await repo.write({ "src/new.ts": "export async function f(db) {\n  db.commit();\n}\n" });
      const hook = await cli(["check", "--hook", "claude-code"], repo.dir, JSON.stringify({ cwd: repo.dir, tool_input: { file_path: join(repo.dir, "src", "new.ts") } }));
      expect(hook.stderr).toContain('"shop" vaccine: learned from the fix "fix: await db commit" in example/shop (abcdef1)');
    } finally {
      await source.cleanup();
      await rm(vaccines, { recursive: true, force: true });
    }
  });

  it("init configures Cursor, Gemini CLI, Codex and MCP", async () => {
    repo = await makeRepo();
    await repo.commit({ "README.md": "x\n" }, "init");
    expect((await cli(["init", "--cursor", "--gemini", "--codex", "--mcp"], repo.dir)).code).toBe(0);
    const read = async (p: string) => JSON.parse(await readFile(join(repo.dir, p), "utf8"));
    expect((await read(".cursor/hooks.json")).hooks.stop[0].command).toBe("npx -y bugvax check --hook cursor");
    expect((await read(".cursor/hooks.json")).version).toBe(1);
    expect((await read(".gemini/settings.json")).hooks.AfterTool[0].matcher).toBe("write_file|replace");
    expect((await read(".codex/hooks.json")).hooks.PostToolUse[0].hooks[0].command).toBe("npx -y bugvax check --hook codex");
    expect(JSON.stringify((await read(".mcp.json")).mcpServers.bugvax)).toContain("bugvax");
    expect((await read(".cursor/mcp.json")).mcpServers.bugvax).toBeDefined();
    await cli(["init", "--cursor", "--gemini", "--codex", "--mcp"], repo.dir);
    expect((await read(".cursor/hooks.json")).hooks.stop).toHaveLength(1);
    expect((await read(".codex/hooks.json")).hooks.PostToolUse).toHaveLength(1);
  });
});
