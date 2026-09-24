import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  it("reports paths it cannot check as errors, not as clean code", async () => {
    const tool = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
    const outside = await tool("check_code", { path: join(tmpdir(), "elsewhere", "invoices.ts") });
    expect(outside.isError).toBe(true);
    expect(outside.content[0].text).toContain("outside the repository");
    const missing = await tool("check_code", { path: "src/new.ts" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("does not exist");
    // Code for a file outside the repository can still be checked by passing it.
    const buggy = REFUNDS_FIXED.replace("await db.commit();", "db.commit();");
    expect((await tool("check_code", { path: join(tmpdir(), "elsewhere", "refunds.ts"), content: buggy })).content[0].text).toContain("[unawaited-db-commit]");
    expect((await tool("scan", { paths: ["src/nope.ts"] })).isError).toBe(true);
    const injected = await tool("fix", { paths: ["--inline-rules", "id: x\nlanguage: tsx\nrule: {pattern: '\"a\"'}\nfix: '\"b\"'", "src"] });
    expect(injected.isError).toBe(true);
  });

  it("matches short words in the bug history", async () => {
    expect(await call("bug_history", { query: "db" })).toContain("[unawaited-db-commit]");
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

describe("MCP server started in a subdirectory", () => {
  let repo: TestRepo;
  let client: Client;

  beforeAll(async () => {
    repo = await repoWithAntibody();
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    client = new Client({ name: "bugvax-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", TSX, CLI, "mcp"], cwd: join(repo.dir, "src"), env }));
  });
  afterAll(async () => {
    await client?.close();
    await repo?.cleanup();
  });

  it("resolves paths from the repository root, as documented, and from its own directory", async () => {
    const check = async (path: string) =>
      ((await client.callTool({ name: "check_code", arguments: { path } })) as { content: { text: string }[] }).content[0].text;
    expect(await check("src/invoices.ts")).toContain("src/invoices.ts:6");
    expect(await check("invoices.ts")).toContain("src/invoices.ts:6");
  });
});
