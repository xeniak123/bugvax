import type { Match } from "../core/engine.js";
import { runFix } from "../core/fixer.js";
import { repoRelative, repoRoot } from "../core/git.js";
import { Store } from "../core/store.js";
import { codeLine, header, loc, pc, plural } from "../ui.js";

/**
 * Apply the proven fix templates of every antibody to the code they match. Antibodies only carry a
 * fix when bugvax verified that the template reproduces the real historical fix.
 */
export async function fixCommand(paths: string[], opts: { dryRun?: boolean; json?: boolean }): Promise<number> {
  const root = await repoRoot(process.cwd());
  const store = new Store(root);
  const antibodies = await store.antibodies();
  if (!antibodies.length) {
    console.log(pc.dim("\nNo antibodies yet. Run `bugvax learn` first."));
    return 0;
  }
  const config = await store.config();
  const globs = config.exclude.map((g) => (g.startsWith("!") ? g : `!${g}`));
  const targets = paths.length ? paths.map((p) => repoRelative(root, p)).filter((p): p is string => p !== null) : ["."];
  const { found, applied, remaining } = await runFix(
    antibodies.map((a) => a.doc),
    targets,
    root,
    { globs, dryRun: opts.dryRun },
  );

  if (opts.json) {
    console.log(JSON.stringify(opts.dryRun ? { fixable: found.filter((m) => m.fix), manual: found.filter((m) => !m.fix) } : { applied, remaining }, null, 2));
    return remaining.length ? 1 : 0;
  }
  header("fix", opts.dryRun ? "dry run: nothing is written" : undefined);
  if (!found.length) {
    console.log(pc.green("\n  ✓ Nothing to fix."));
    return 0;
  }
  if (opts.dryRun) {
    const fixable = found.filter((m) => m.fix);
    for (const m of fixable) printChange(m);
    printManual(found.filter((m) => !m.fix));
    if (fixable.length) console.log(`\n  ${pc.bold(plural(fixable.length, "fix", "fixes"))} ready. Run ${pc.bold("bugvax fix")} to apply.`);
    console.log();
    return 1;
  }
  if (applied.length) {
    const files = new Set(applied.map((m) => m.file)).size;
    console.log(`\n  ${pc.green(pc.bold(`🔧 fixed ${plural(applied.length, "bug")} in ${plural(files, "file")}`))}`);
    for (const m of applied) printChange(m);
  }
  const stillFixable = remaining.filter((m) => m.fix);
  if (stillFixable.length) {
    console.log(pc.yellow(`\n  ${plural(stillFixable.length, "fix", "fixes")} could not be applied automatically:`));
    for (const m of stillFixable) console.log(`    ${loc(m)}  ${pc.dim(m.ruleId)}`);
  }
  printManual(remaining.filter((m) => !m.fix));
  if (applied.length) console.log(pc.dim(`\n  Review the changes with ${pc.reset("git diff")}; undo with ${pc.reset("git checkout -- <file>")}.`));
  console.log();
  return remaining.length ? 1 : 0;
}

function printChange(m: Match): void {
  console.log(`\n    ${loc(m)}  ${pc.dim(m.ruleId)}`);
  for (const line of preview(m.text)) console.log(`      ${pc.red(`- ${line}`)}`);
  for (const line of preview(m.fix!.text)) console.log(`      ${pc.green(`+ ${line}`)}`);
}

function printManual(manual: Match[]): void {
  if (!manual.length) return;
  console.log(pc.yellow(`\n  ${plural(manual.length, "finding needs", "findings need")} a manual fix (no proven auto-fix for these antibodies):`));
  for (const m of manual) console.log(`    ${loc(m)}  ${pc.dim(m.ruleId)}  ${codeLine(m.lines, 60)}`);
}

function preview(text: string, max = 4): string[] {
  const lines = text.split(/\r?\n/);
  const shown = lines.slice(0, max);
  if (lines.length > max) shown.push("…");
  return shown;
}
