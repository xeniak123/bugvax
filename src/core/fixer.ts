import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyFixes, scan, type Match, type RuleDoc } from "./engine.js";

export interface FixRun {
  /** Everything the antibodies matched before fixing. */
  found: Match[];
  /** Fixes written to disk (empty on a dry run). */
  applied: Match[];
  /** Matches left after fixing (on a dry run: the same as `found`). */
  remaining: Match[];
}

/**
 * Apply the fix templates of `rules` to the code they match under `targets`, then rescan.
 * Overlapping fixes in one file are picked up in a later pass.
 */
export async function runFix(rules: RuleDoc[], targets: string[], root: string, opts: { globs?: string[]; dryRun?: boolean } = {}): Promise<FixRun> {
  const found = await scan(rules, targets, root, { globs: opts.globs });
  if (opts.dryRun || !found.some((m) => m.fix)) return { found, applied: [], remaining: found };

  const applied: Match[] = [];
  // Byte ranges each rule already rewrote, per file (in the file's current coordinates).
  const done = new Map<string, { ruleId: string; start: number; end: number }[]>();
  const alreadyFixed = (m: Match) => done.get(m.file)?.some((r) => r.ruleId === m.ruleId && m.fix!.start < r.end && r.start < m.fix!.end) ?? false;
  let pending = found.filter((m) => m.fix);
  for (let pass = 0; pass < 3 && pending.length; pass++) {
    const byFile = new Map<string, Match[]>();
    for (const m of pending) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
    let progress = 0;
    let skipped = 0;
    for (const [file, ms] of byFile) {
      const abs = join(root, file);
      const result = applyFixes(await readFile(abs), ms);
      skipped += ms.length - result.applied.length;
      if (!result.applied.length) continue;
      await writeFile(abs, result.content);
      applied.push(...result.applied);
      progress += result.applied.length;
      // Earlier ranges shift with this pass's edits; keep only the new ones plus shifted old ones.
      const shifted = (done.get(file) ?? []).map((r) => shiftRange(r, result.applied));
      done.set(file, [...shifted, ...result.rewritten]);
    }
    // Another pass is only for matches that overlapped a fix applied in this one.
    if (!progress || !skipped) break;
    pending = (await scan(rules, [...byFile.keys()], root, { globs: opts.globs })).filter((m) => m.fix && !alreadyFixed(m));
  }
  const remaining = await scan(rules, targets, root, { globs: opts.globs });
  return { found, applied, remaining };
}

/** Move a byte range to account for replacements made before it. */
function shiftRange<T extends { start: number; end: number }>(r: T, applied: Match[]): T {
  let delta = 0;
  for (const m of applied) {
    if (m.fix!.end <= r.start) delta += Buffer.byteLength(m.fix!.text, "utf8") - (m.fix!.end - m.fix!.start);
  }
  return { ...r, start: r.start + delta, end: r.end + delta };
}
