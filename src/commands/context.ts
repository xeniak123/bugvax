import { historyLine, oneLine } from "../agent.js";
import { scan, type Match } from "../core/engine.js";
import { displayPrefix, sessionRoots } from "../core/git.js";
import { languageById } from "../core/languages.js";
import { antibodyMeta, Store, type Antibody } from "../core/store.js";
import { excludeGlobs, readHookInput, recordSessionStart } from "./check.js";

export interface ContextOptions {
  hook?: string;
}

const MAX_ANTIBODIES = 40;
const MAX_LATENT = 25;
const SCAN_BUDGET_MS = 20_000;

/**
 * A short briefing for an AI agent at the start of a session: which bugs this repository already
 * fixed, and where copies of them still live, so the agent neither re-introduces nor imitates them.
 * Prints nothing when the repository has no antibodies.
 */
export async function contextCommand(opts: ContextOptions): Promise<number> {
  let cwd = process.cwd();
  let sessionId: string | undefined;
  if (opts.hook) {
    const input = await readHookInput();
    cwd = input.cwd ?? cwd;
    sessionId = input.session_id;
  }
  const roots = await sessionRoots(cwd);
  if (!roots.length) {
    if (opts.hook) return 0; // not a git repository: nothing to say, never break the session
    throw new Error("Not inside a git repository. bugvax learns from git history, so run it inside a repo.");
  }
  const parts: string[] = [];
  for (const root of roots) {
    const store = new Store(root);
    const antibodies = await store.antibodies().catch((e: Error) => {
      if (opts.hook) return [] as Antibody[];
      throw e;
    });
    if (opts.hook) await recordSessionStart(root, sessionId).catch(() => {});
    if (!antibodies.length) continue;
    const latent = await withBudget(scan(antibodies.map((a) => a.doc), ["."], root, { globs: await excludeGlobs(store) }), SCAN_BUDGET_MS);
    parts.push(briefing(antibodies, latent, { hooked: Boolean(opts.hook), prefix: displayPrefix(cwd, root) }));
  }
  if (parts.length) console.log(parts.join("\n\n"));
  return 0;
}

async function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  try {
    return await Promise.race([p.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function briefing(antibodies: Antibody[], latent: Match[] | null, opts: { hooked?: boolean; prefix?: string } = {}): string {
  const label = (lang: string) => languageById(lang)?.label ?? lang;
  const prefix = opts.prefix ?? "";
  const repo = prefix ? `The repository in ${prefix}` : "This repository";
  const lines = [
    `# bugvax: bugs ${prefix ? `the repository in ${prefix}` : "this repository"} already fixed`,
    "",
    `${repo} has ${antibodies.length} bugvax antibod${antibodies.length === 1 ? "y" : "ies"}: bug classes it fixed before, learned from its git history. ` +
      (opts.hooked ? "Every edit you make is checked against them, and so is your work before you finish. " : "") +
      "Do not re-introduce these bugs, and do not copy code that still contains them.",
    "",
    "Bug classes fixed here before:",
  ];
  for (const a of antibodies.slice(0, MAX_ANTIBODIES)) {
    const meta = antibodyMeta(a.doc);
    const history = meta ? ` (${oneLine(historyLine(meta), 120)})` : "";
    lines.push(`- [${a.doc.id}] ${label(a.doc.language)}: ${oneLine(a.doc.message ?? meta?.title ?? a.doc.id, 200)}${history}`);
  }
  if (antibodies.length > MAX_ANTIBODIES) lines.push(`- … and ${antibodies.length - MAX_ANTIBODIES} more (\`npx bugvax list\`).`);

  if (latent === null) {
    lines.push("", "Latent copies: the scan did not finish in time; run `npx bugvax scan` to list them.");
  } else if (latent.length) {
    lines.push(
      "",
      "Known-bad code that still contains one of these bugs. Do not use it as an example for new code; if your task touches it, fix it:",
    );
    for (const m of latent.slice(0, MAX_LATENT)) {
      lines.push(`- ${prefix}${m.file}:${m.line} [${m.ruleId}] \`${oneLine(m.lines.split(/\r?\n/)[0], 120)}\`${m.fix ? " (proven auto-fix: `npx bugvax fix`)" : ""}`);
    }
    if (latent.length > MAX_LATENT) lines.push(`- … and ${latent.length - MAX_LATENT} more (\`npx bugvax scan\`).`);
  }
  lines.push(
    "",
    "Before you write code modelled on existing code, check it: the bugvax MCP tool `check_code` (pass `content`) or `npx bugvax check <file>`. " +
      "After you fix a real bug, `learn_from_fix` (or `npx bugvax learn --working -m \"what was wrong\"`) turns it into a new antibody.",
  );
  return lines.join("\n");
}
