import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INVOICES, REFUNDS_FIXED, repoWithAntibody, type TestRepo } from "./helpers.js";

const ROOT = resolve(import.meta.dirname, "..");
const TSX = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const CLI = join(ROOT, "src", "cli.ts");

describe("MCP server", () => {
  let repo: TestRepo;
  let client: Client;

  beforeAll(async () => {
    repo = await repoWithAntibody("await $DB.commit()");
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    client = new Client({ name: "bugvax-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", TSX, CLI, "mcp"], cwd: repo.dir, env }));
  });
  afterAll(async () => {
    await client?.close();
    await repo?.cleanup();
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[] };
    return res.content.map((c) => c.text).join("\n");
  };

  it("lists its tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["bug_history", "check_code", "fix", "learn_from_fix", "scan"]);
  });

  it("checks code before it is written", async () => {
    const buggy = REFUNDS_FIXED.replace("await db.commit();", "db.commit();");
    const text = await call("check_code", { path: "src/refunds.ts", content: buggy });
    expect(text).toContain("src/refunds.ts:6  [unawaited-db-commit]");
    expect(text).toContain("proven fix: replace `db.commit()` with `await db.commit()`");
    expect(text).toContain('fixed before in abcdef1 "fix: await db commit"');
    expect(await call("check_code", { path: "src/refunds.ts", content: REFUNDS_FIXED })).toContain("No known bugs");
  });

  it("answers what went wrong here before", async () => {
    const text = await call("bug_history", { path: "src/refunds.ts" });
    expect(text).toContain("[unawaited-db-commit] Unawaited db.commit()");
    expect(text).toContain("auto-fix: yes");
    expect(await call("bug_history", { path: "app/models.py" })).toContain("No matching bug history");
  });

  it("scans and fixes", async () => {
    expect(await call("scan", {})).toContain("src/invoices.ts:6");
    expect(await call("fix", { dry_run: true })).toContain("Would apply 1 fix(es)");
    expect(await readFile(join(repo.dir, "src", "invoices.ts"), "utf8")).toBe(INVOICES);
    expect(await call("fix", {})).toContain("Applied 1 fix(es)");
    expect(await readFile(join(repo.dir, "src", "invoices.ts"), "utf8")).toContain("  await db.commit();\n}\n\nexport async function payInvoice");
    expect(await call("scan", {})).toContain("No known bugs found");
  });
});
