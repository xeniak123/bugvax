import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { git } from "../src/core/git.js";
import { Store } from "../src/core/store.js";

export interface TestRepo {
  dir: string;
  write(files: Record<string, string>): Promise<void>;
  commit(files: Record<string, string>, message: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function makeRepo(): Promise<TestRepo> {
  const dir = await mkdtemp(join(tmpdir(), "bugvax-test-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.name", "bugvax test"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "core.autocrlf", "false"]);
  const write = async (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
  };
  return {
    dir,
    write,
    async commit(files, message) {
      await write(files);
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-q", "-m", message]);
      return (await git(dir, ["rev-parse", "HEAD"])).trim();
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export const REFUNDS_BUGGY = `import { db } from "./db";

export async function refund(orderId: string) {
  const order = await db.orders.find(orderId);
  order.status = "refunded";
  db.commit();
  return order;
}
`;

export const REFUNDS_FIXED = `import { db } from "./db";

export async function refund(orderId: string) {
  const order = await db.orders.find(orderId);
  order.status = "refunded";
  await db.commit();
  return order;
}
`;

export const INVOICES = `import { db } from "./db";

export async function voidInvoice(id: string) {
  const invoice = await db.invoices.find(id);
  invoice.voided = true;
  db.commit();
}

export async function payInvoice(id: string) {
  const invoice = await db.invoices.find(id);
  invoice.paid = true;
  await db.commit();
}
`;

/** A repo whose last commit fixes an un-awaited commit() in refunds.ts, while invoices.ts still has the bug. */
export async function unawaitedCommitRepo(): Promise<{ repo: TestRepo; fixSha: string }> {
  const repo = await makeRepo();
  await repo.commit({ "src/refunds.ts": REFUNDS_BUGGY, "src/invoices.ts": INVOICES, "README.md": "# shop\n" }, "initial shop");
  const fixSha = await repo.commit({ "src/refunds.ts": REFUNDS_FIXED }, "fix: await db commit in refunds");
  return { repo, fixSha };
}

export const GOOD_RULE_YAML = `rule:
  pattern: $DB.commit()
  not:
    inside:
      any:
        - kind: await_expression
        - kind: return_statement
`;

/** A repo with the fixed refunds.ts, the still-buggy invoices.ts, and a stored antibody for the bug. */
export async function repoWithAntibody(fix?: string): Promise<TestRepo> {
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
    ...(fix ? { fix } : {}),
    metadata: {
      bugvax: {
        title: "Unawaited db.commit()",
        learnedAt: "",
        source: { kind: "commit", commit: "abcdef1234", subject: "fix: await db commit", files: ["src/refunds.ts"] },
        validation: {},
      },
    },
  });
  return repo;
}
