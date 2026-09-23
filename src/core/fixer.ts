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
  let pending = found.filter((m) => m.fix);
  for (let pass = 0; pass < 3 && pending.length; pass++) {
    const byFile = new Map<string, Match[]>();
    for (const m of pending) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
    let progress = 0;
    for (const [file, ms] of byFile) {
      const abs = join(root, file);
      const result = applyFixes(await readFile(abs), ms);
      if (!result.applied.length) continue;
      await writeFile(abs, result.content);
      applied.push(...result.applied);
      progress += result.applied.length;
    }
    if (!progress) break;
    pending = (await scan(rules, [...byFile.keys()], root, { globs: opts.globs })).filter((m) => m.fix);
  }
  const remaining = await scan(rules, targets, root, { globs: opts.globs });
  return { found, applied, remaining };
}
