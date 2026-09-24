#!/usr/bin/env node
// Does an AI coding agent write better code with bugvax than without it?
//
// Each task asks Claude Code (headless, `claude -p`) to add code "in the style of" an existing
// function. Those functions still contain latent copies of bugs the repository already fixed,
// which is exactly how agents re-introduce old bugs: they imitate nearby code.
//
// Two suites:
//   shop    the `bugvax demo` shop: classic bug classes a strong model often knows to avoid anyway
//   ledger  scripts/eval-repo.mjs: this project's own conventions (a money helper, an outbox, a
//           tenant filter, a UTC date parser, a nullable lookup) that exist only in its git history
//
// Conditions:
//   baseline  plain Claude Code, no bugvax anywhere in the repository
//   bugvax    the bugvax plugin setup: session briefing, check after every edit, check before
//             finishing, the MCP server and the skill
//
// Scoring is deterministic: the repository's learned antibodies are run over the lines the agent
// added, the task's expected symbol must exist, and the antibody files must be untouched.
// Antibodies are learned from recorded model answers, so building the repositories costs nothing.
//
//   npm run build && node scripts/eval-agents.mjs --suite ledger --trials 2 --model sonnet
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cli = join(repoRoot, "dist", "cli.js");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "true" : all[i + 1]]] : acc), []),
);
const TRIALS = Number(args.trials ?? 1);
const MODEL = args.model ?? "sonnet";
const CONCURRENCY = Number(args.concurrency ?? 3);
const OUT = resolve(args.out ?? join(repoRoot, "eval"));
const ONLY = args.tasks ? new Set(args.tasks.split(",")) : null;
const CONDITIONS = (args.conditions ?? "baseline,bugvax").split(",");
const SUITE = args.suite ?? "shop";

const SUITES = {
  shop: {
    title: "demo shop: classic bug classes",
    cache: join(repoRoot, "scripts", ".demo-cache"),
    create: (work) => bugvax(work, ["demo", "template"]),
    tasks: SHOP_TASKS(),
  },
  ledger: {
    title: "ledger: project-specific conventions learned from its history",
    cache: join(repoRoot, "scripts", ".eval-cache"),
    create: (work) => sh(process.execPath, [join(here, "eval-repo.mjs"), "template"], work),
    tasks: [
      {
        id: "withdraw",
        exemplar: "deposit(): no null check on getAccount, Math.round cents, bus.emit",
        file: "src/withdrawals.ts",
        expect: /withdraw/,
        prompt:
          'Add an exported function withdraw(accountId: string, amount: number) in a new file src/withdrawals.ts. It works like deposit() in src/deposits.ts, but subtracts the amount, throws an Error when the balance is too low, and emits a "withdrawal.completed" event. Return the new balance.',
      },
      {
        id: "export-csv",
        exemplar: "monthlyTotals(): query without tenant scope, new Date(row.date)",
        file: "src/exports.ts",
        expect: /exportCsv/,
        prompt:
          'Add a new file src/exports.ts with an exported function exportCsv(tenantId: string, accountId: string): string that returns the account\'s transactions as CSV, one "id,cents,date" line per transaction with the date as an ISO string. Load the transactions the same way monthlyTotals() in src/reports.ts does.',
      },
      {
        id: "charge-fee",
        exemplar: "deposit(): no null check on getAccount, bus.emit",
        file: "src/fees.ts",
        expect: /chargeFee/,
        prompt:
          'In src/fees.ts, add an exported function chargeFee(accountId: string, amount: number) that deducts calculateFee(amount) cents from the account\'s balance and emits a "fee.charged" event with the account id and the fee, updating the account the same way deposit() in src/deposits.ts does. Return the fee.',
      },
    ],
  },
};
const suite = SUITES[SUITE];
if (!suite) throw new Error(`unknown suite ${SUITE}; use ${Object.keys(SUITES).join(" or ")}`);
const TASKS = suite.tasks.filter((t) => !ONLY || ONLY.has(t.id));

function SHOP_TASKS() {
  return [
  {
    id: "refund-invoice",
    exemplar: "unawaited-db-commit",
    file: "src/invoices.ts",
    expect: /refundInvoice/,
    prompt:
      'In src/invoices.ts, add an exported async function refundInvoice(id: string) that loads the invoice, sets its status to "refunded" and saves the change to the database, in the same style as the other functions in that file.',
  },
  {
    id: "owner-middleware",
    exemplar: "missing-return-after-error-response",
    file: "src/middleware/owner.ts",
    expect: /requireOwner/,
    prompt:
      'Add an Express middleware requireOwner in a new file src/middleware/owner.ts. It should respond with status 403 and { error: "not the owner" } when req.user?.id !== req.params.userId, and otherwise let the request continue. Follow the pattern of the existing middleware in src/middleware.',
  },
  {
    id: "favorites",
    exemplar: "mutable-default-argument",
    file: "app/wishlist.py",
    expect: /def add_to_favorites/,
    prompt:
      "In app/wishlist.py, add a function add_to_favorites(user, item, labels) that appends the item to user.favorites and records the item's name in labels, where labels is an optional dict the caller may pass in. Follow the style of add_to_wishlist and return labels.",
  },
  {
    id: "refund-charge",
    exemplar: "requests-call-without-timeout",
    file: "app/payments.py",
    expect: /def refund/,
    prompt:
      'In app/payments.py, add a function refund(charge_id: str) -> str that POSTs to f"{PAYMENTS_URL}/{charge_id}/refunds" with requests and returns the refund id from the JSON response, like charge().',
  },
  {
    id: "payment-list",
    exemplar: "use-effect-missing-dependency-array",
    file: "src/components/PaymentList.tsx",
    expect: /PaymentList/,
    prompt:
      "Create a React component PaymentList in src/components/PaymentList.tsx that loads /payments from the api module and renders a list of payment ids, like InvoiceList.",
  },
  {
    id: "top-refunds",
    exemplar: "numeric-sort-without-comparator",
    file: "src/leaderboard.ts",
    expect: /topRefundAmounts/,
    prompt:
      "In src/leaderboard.ts, add an exported function topRefundAmounts(amounts: number[], n = 5): number[] that returns the n largest amounts, largest first, in the same style as rankScores.",
  },
];
}

const sh = (cmd, argv, cwd, env = process.env) => execFileSync(cmd, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString();
const git = (cwd, ...argv) => sh("git", argv, cwd);
const bugvax = (cwd, argv, env) => sh(process.execPath, [cli, ...argv], cwd, env);

function findClaude() {
  if (process.env.BUGVAX_CLAUDE_BIN) return process.env.BUGVAX_CLAUDE_BIN;
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (process.platform !== "win32" && existsSync(join(dir, "claude"))) return join(dir, "claude");
    if (existsSync(join(dir, "claude.exe"))) return join(dir, "claude.exe");
    const cmd = join(dir, "claude.cmd");
    if (existsSync(cmd)) {
      const m = /"%dp0%\\([^"]+?\.exe)"/i.exec(readFileSync(cmd, "utf8"));
      if (m) return join(dir, m[1]);
    }
  }
  throw new Error("claude not found on PATH");
}

// 1. A template repository with its antibodies learned from the recorded model answers (no model
//    calls), committed so every run starts from the same state.
const work = mkdtempSync(join(tmpdir(), "bugvax-eval-"));
const template = join(work, "template");
console.log(`eval workspace: ${work}`);
suite.create(work);
bugvax(template, ["learn", "--provider", "claude-code"], { ...process.env, BUGVAX_LLM_CACHE: suite.cache, NO_COLOR: "1" });
const antibodyDir = join(template, ".bugvax", "antibodies");
const antibodies = readdirSync(antibodyDir).map((f) => f.replace(/\.ya?ml$/, ""));
console.log(`antibodies: ${antibodies.join(", ")}`);
// Both conditions ignore node_modules, where the bugvax condition gets its local `bugvax` command.
const gitignore = join(template, ".gitignore");
writeFileSync(gitignore, (existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "") + "node_modules/\n");
git(template, "add", "-A");
git(template, "commit", "-q", "-m", "bugvax antibodies");
const groundTruth = join(work, "ground-truth");
cpSync(join(template, ".bugvax"), groundTruth, { recursive: true });
const skill = readFileSync(join(repoRoot, "plugin", "skills", "bugvax", "SKILL.md"), "utf8");

function setup(dir, condition) {
  git(work, "clone", "-q", template, dir);
  git(dir, "config", "user.name", "eval");
  git(dir, "config", "user.email", "eval@example.com");
  if (condition === "baseline") {
    rmSync(join(dir, ".bugvax"), { recursive: true, force: true });
  } else {
    // The same hooks the Claude Code plugin installs, pointing at this build of bugvax.
    const hook = (...a) => ({ type: "command", command: process.execPath, args: [cli, ...a], timeout: 60 });
    mkdirSync(join(dir, ".claude", "skills", "bugvax"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "bugvax", "SKILL.md"), skill);
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [hook("context", "--hook", "claude-code")] }],
            PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [hook("check", "--hook", "claude-code")] }],
            Stop: [{ hooks: [hook("check", "--hook", "claude-code-stop")] }],
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { bugvax: { command: process.execPath, args: [cli, "mcp"] } } }, null, 2));
    // `npx bugvax ...` (used by the skill) resolves to this build, as it would to an installed package.
    const bin = join(dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "bugvax.cmd"), `@"${process.execPath}" "${cli}" %*\r\n`);
    writeFileSync(join(bin, "bugvax"), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", `eval setup: ${condition}`);
}

function runClaude(dir, task, condition) {
  const argv = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--setting-sources",
    "project,local",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--model",
    MODEL,
    ...(condition === "bugvax" ? ["--mcp-config", join(dir, "mcp.json")] : []),
  ];
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(findClaude(), argv, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), 12 * 60 * 1000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(out);
      } catch {
        /* reported below */
      }
      done({ code, json, err: err.slice(-2000), seconds: Math.round((Date.now() - started) / 1000) });
    });
    child.stdin.end(task.prompt);
  });
}

function score(dir, task) {
  // Every line the agent added: tracked changes against the setup commit, plus new files.
  const changed = git(dir, "status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
    .filter((p) => p && !p.startsWith(".bugvax/") && !p.startsWith(".claude/") && p !== "mcp.json");
  // Scan with the ground-truth antibodies from outside the repository, so an agent editing
  // .bugvax/ cannot change its own score.
  const probe = mkdtempSync(join(tmpdir(), "bugvax-score-"));
  let findings = [];
  try {
    git(work, "clone", "-q", dir, join(probe, "r"));
    const r = join(probe, "r");
    for (const p of changed) {
      const src = join(dir, p);
      if (!existsSync(src)) continue;
      mkdirSync(dirname(join(r, p)), { recursive: true });
      cpSync(src, join(r, p));
    }
    rmSync(join(r, ".bugvax"), { recursive: true, force: true });
    cpSync(groundTruth, join(r, ".bugvax"), { recursive: true });
    let json = "[]";
    try {
      json = bugvax(r, ["check", "--json"]);
    } catch (e) {
      json = e.stdout?.toString() || "[]";
    }
    findings = JSON.parse(json).map((m) => ({ rule: m.ruleId, at: `${m.file}:${m.line}`, code: m.lines.trim() }));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  const target = join(dir, task.file);
  const done = existsSync(target) && task.expect.test(readFileSync(target, "utf8"));
  let tampered = false;
  if (existsSync(join(dir, ".bugvax"))) {
    tampered = git(dir, "status", "--porcelain", "--", ".bugvax").trim() !== "";
  }
  return { changed, findings, done, tampered };
}

async function one(task, condition, trial) {
  const dir = join(work, `${task.id}-${condition}-${trial}`);
  setup(dir, condition);
  const run = await runClaude(dir, task, condition);
  const s = score(dir, task);
  git(dir, "add", "-A", "--intent-to-add"); // so new files show up in the recorded diff
  const result = {
    suite: SUITE,
    task: task.id,
    condition,
    trial,
    model: MODEL,
    completed: s.done,
    reintroduced: s.findings.length,
    findings: s.findings,
    tamperedWithAntibodies: s.tampered,
    changed: s.changed,
    seconds: run.seconds,
    turns: run.json?.num_turns ?? null,
    costUsd: run.json?.total_cost_usd ?? null,
    error: run.json?.is_error ? String(run.json.result).slice(0, 300) : run.code !== 0 && !run.json ? run.err.slice(-300) : null,
    diff: git(dir, "diff", "HEAD").slice(0, 6000),
  };
  const mark = result.error ? "ERR" : result.reintroduced ? `${result.reintroduced} bug(s)` : "clean";
  console.log(`${task.id.padEnd(18)} ${condition.padEnd(9)} #${trial}  ${mark.padEnd(9)} done=${result.completed} ${run.seconds}s`);
  return result;
}

const jobs = [];
for (let trial = 1; trial <= TRIALS; trial++) for (const task of TASKS) for (const c of CONDITIONS) jobs.push([task, c, trial]);
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const [task, c, trial] = jobs[next++];
      try {
        results.push(await one(task, c, trial));
      } catch (e) {
        console.log(`${task.id} ${c} #${trial} crashed: ${e.message}`);
        results.push({ task: task.id, condition: c, trial, model: MODEL, error: e.message });
      }
    }
  }),
);

// 2. Summary
const valid = results.filter((r) => !r.error);
const summary = {};
for (const c of CONDITIONS) {
  const rs = valid.filter((r) => r.condition === c);
  summary[c] = {
    runs: rs.length,
    completed: rs.filter((r) => r.completed).length,
    runsWithKnownBug: rs.filter((r) => r.reintroduced > 0).length,
    knownBugs: rs.reduce((n, r) => n + r.reintroduced, 0),
    tampered: rs.filter((r) => r.tamperedWithAntibodies).length,
    avgSeconds: rs.length ? Math.round(rs.reduce((n, r) => n + r.seconds, 0) / rs.length) : 0,
    costUsd: Number(rs.reduce((n, r) => n + (r.costUsd ?? 0), 0).toFixed(2)),
  };
}
mkdirSync(OUT, { recursive: true });
const stamp = args.stamp ?? "latest";
writeFileSync(join(OUT, `results-${SUITE}-${MODEL}-${stamp}.json`), JSON.stringify({ suite: SUITE, model: MODEL, trials: TRIALS, antibodies, summary, results }, null, 2));
const lines = [
  `# bugvax agent eval: ${suite.title} (${MODEL}, ${TRIALS} trial${TRIALS > 1 ? "s" : ""} per task)`,
  "",
  `Antibodies: ${antibodies.join(", ")}`,
  "",
  "| task | known bugs in the code it imitates | " + CONDITIONS.join(" | ") + " |",
  "|---|---|" + CONDITIONS.map(() => "---").join("|") + "|",
  ...TASKS.map((t) => {
    const cells = CONDITIONS.map((c) => {
      const rs = valid.filter((r) => r.task === t.id && r.condition === c);
      if (!rs.length) return "n/a";
      return rs.map((r) => (r.reintroduced ? `${r.reintroduced} bug${r.reintroduced > 1 ? "s" : ""}${r.completed ? "" : " (not done)"}` : r.completed ? "clean" : "not done")).join(", ");
    });
    return `| ${t.id} | ${t.exemplar} | ${cells.join(" | ")} |`;
  }),
  "",
  ...CONDITIONS.map((c) => {
    const s = summary[c];
    return `- **${c}**: ${s.runsWithKnownBug}/${s.runs} runs re-introduced a known bug (${s.knownBugs} findings), ${s.completed}/${s.runs} completed the task, ${s.tampered} touched the antibodies, avg ${s.avgSeconds}s, $${s.costUsd}`;
  }),
];
writeFileSync(join(OUT, `results-${SUITE}-${MODEL}-${stamp}.md`), lines.join("\n") + "\n");
console.log("\n" + lines.join("\n"));
if (!args.keep) rmSync(work, { recursive: true, force: true });
