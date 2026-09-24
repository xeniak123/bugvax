#!/usr/bin/env node
// Creates "ledger", the repository for the project-specific half of the agent eval.
// Its history fixes bugs that break this project's own conventions (a helper that must be used,
// an outbox instead of a bus, a tenant filter, a UTC date parser, a nullable lookup). A model
// cannot know these rules from general knowledge; they only exist in the history. Each fixed
// bug still has a latent copy somewhere else, exactly like real codebases.
//   node scripts/eval-repo.mjs <dir>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "ledger");
if (existsSync(join(dir, ".git"))) {
  console.error(`${dir} already contains a git repository`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString();
git("init", "-q", "-b", "main");
git("config", "user.name", "Ledger Dev");
git("config", "user.email", "dev@example.com");
git("config", "core.autocrlf", "false");

let day = 0;
function commit(message, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content.replace(/^\n/, ""));
  }
  git("add", "-A");
  const date = new Date(Date.UTC(2026, 1, 2 + day++ * 4, 9)).toISOString();
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}

const transfersBuggy = `
import { getAccount } from "./accounts";
import { bus } from "./events";

export function transfer(fromId: string, toId: string, amount: number) {
  const from = getAccount(fromId);
  const to = getAccount(toId);
  const cents = Math.round(amount * 100);
  from.balance -= cents;
  to.balance += cents;
  bus.emit("transfer.completed", { fromId, toId, cents });
  return { fromId, toId, cents };
}
`;

const statementsBuggy = `
import { db } from "./db";

export function statement(tenantId: string, accountId: string) {
  const rows = db.query(\`SELECT * FROM transactions WHERE account_id = '\${accountId}'\`);
  return rows.map((row) => ({
    id: row.id,
    cents: row.cents,
    date: new Date(row.date),
  }));
}
`;

commit("initial ledger service", {
  "README.md": "# ledger\n\nAccounts, transfers and statements for a multi-tenant wallet.\n",
  "package.json": '{ "name": "ledger", "private": true }\n',
  "src/db.ts": `
export interface Row { id: string; cents: number; date: string; account_id: string; tenant_id: string }

export const db = {
  /** Runs a query. Pass { tenantId } to scope it to one tenant. */
  query(sql: string, opts?: { tenantId: string }): Row[] {
    return [];
  },
};
`,
  "src/accounts.ts": `
export interface Account { id: string; balance: number; frozen: boolean; closed: boolean }

const accounts = new Map<string, Account>();

/** Returns the account, or null when it does not exist or was closed. */
export function getAccount(id: string): Account | null {
  const account = accounts.get(id);
  return account && !account.closed ? account : null;
}
`,
  "src/money.ts": `
/** Converts an amount in currency units to integer cents without floating-point drift. */
export function toCents(amount: number): number {
  return Math.round(Number((amount * 100).toFixed(2)));
}
`,
  "src/events.ts": `
type Payload = Record<string, unknown>;

/** In-process event bus. */
export const bus = {
  emit(topic: string, payload: Payload): void {},
};

/** Transactional outbox: events are stored with the change and delivered after commit. */
export const outbox = {
  enqueue(topic: string, payload: Payload): void {},
};
`,
  "src/dates.ts": `
/** Parses a stored ISO date (always UTC) without local time-zone shifts. */
export function parseDate(value: string): Date {
  return new Date(value.endsWith("Z") ? value : value + "Z");
}
`,
  "src/transfers.ts": transfersBuggy,
  "src/deposits.ts": `
import { getAccount } from "./accounts";
import { bus } from "./events";

export function deposit(accountId: string, amount: number) {
  const account = getAccount(accountId);
  const cents = Math.round(amount * 100);
  account.balance += cents;
  bus.emit("deposit.completed", { accountId, cents });
  return account.balance;
}
`,
  "src/fees.ts": `
export const FEE_RATE = 0.012;

export function calculateFee(amount: number): number {
  return Math.round(amount * FEE_RATE * 100);
}
`,
  "src/statements.ts": statementsBuggy,
  "src/reports.ts": `
import { db } from "./db";

export function monthlyTotals(tenantId: string, accountId: string) {
  const rows = db.query(\`SELECT * FROM transactions WHERE account_id = '\${accountId}'\`);
  const totals = new Map<string, number>();
  for (const row of rows) {
    const month = new Date(row.date).toISOString().slice(0, 7);
    totals.set(month, (totals.get(month) ?? 0) + row.cents);
  }
  return totals;
}
`,
});

commit("fix: transfers crashed when an account was closed\n\ngetAccount() returns null for closed accounts.", {
  "src/transfers.ts": transfersBuggy.replace(
    "  const to = getAccount(toId);\n",
    '  const to = getAccount(toId);\n  if (!from || !to) throw new Error("account not found or closed");\n',
  ),
});

commit("fix typo in README", {
  "README.md": "# ledger\n\nAccounts, transfers and statements for a multi-tenant wallet service.\n",
});

const afterNull = transfersBuggy.replace(
  "  const to = getAccount(toId);\n",
  '  const to = getAccount(toId);\n  if (!from || !to) throw new Error("account not found or closed");\n',
);
const afterCents = afterNull
  .replace('import { bus } from "./events";', 'import { bus } from "./events";\nimport { toCents } from "./money";')
  .replace("Math.round(amount * 100)", "toCents(amount)");
commit("fix: transfer amounts were off by one cent for some values\n\n0.29 * 100 is 28.999999999999996 in floating point. Use toCents().", {
  "src/transfers.ts": afterCents,
});

commit("fix: transfer events were lost when the process crashed\n\nbus.emit fires before the change is persisted; the outbox stores the event with it.", {
  "src/transfers.ts": afterCents.replace('import { bus } from "./events";', 'import { outbox } from "./events";').replace("bus.emit(", "outbox.enqueue("),
});

commit("fix: statements showed transactions from other tenants", {
  "src/statements.ts": statementsBuggy.replace("}'\`);", "}'\`, { tenantId });"),
});

commit("fix: fee rate is 1.5%, not 1.2%", {
  "src/fees.ts": "\nexport const FEE_RATE = 0.015;\n\nexport function calculateFee(amount: number): number {\n  return Math.round(amount * FEE_RATE * 100);\n}\n",
});

commit("fix: statement dates were a day early for users west of UTC", {
  "src/statements.ts": statementsBuggy
    .replace("}'\`);", "}'\`, { tenantId });")
    .replace('import { db } from "./db";', 'import { db } from "./db";\nimport { parseDate } from "./dates";')
    .replace("new Date(row.date)", "parseDate(row.date)"),
});

console.log(`Ledger repository created in ${dir}`);
console.log(git("log", "--oneline").trim());
