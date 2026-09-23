import { scan } from "../core/engine.js";
import { repoRoot } from "../core/git.js";
import { Store } from "../core/store.js";
import { githubAnnotations, header, pc, plural, printFindings } from "../ui.js";

export async function scanCommand(paths: string[], opts: { json?: boolean }): Promise<number> {
  const root = await repoRoot(process.cwd());
  const store = new Store(root);
  const antibodies = await store.antibodies();
  const config = await store.config();
  if (!antibodies.length) {
    if (opts.json) console.log("[]");
    else console.log(pc.dim("\nNo antibodies yet. Run `bugvax learn` to learn them from your bug-fix history."));
    return 0;
  }
  const globs = config.exclude.map((g) => (g.startsWith("!") ? g : `!${g}`));
  const matches = await scan(antibodies.map((a) => a.doc), paths.length ? paths : ["."], root, { globs });
  if (opts.json) {
    console.log(JSON.stringify(matches, null, 2));
    return matches.length ? 1 : 0;
  }
  header("scan", `${plural(antibodies.length, "antibody", "antibodies")}`);
  if (!matches.length) {
    console.log(pc.green("\n  ✓ No known bugs found. Your codebase is immune to everything it has caught before."));
    return 0;
  }
  printFindings(matches, antibodies);
  githubAnnotations(matches, antibodies);
  const files = new Set(matches.map((m) => m.file)).size;
  const fixable = matches.filter((m) => m.fix).length;
  console.log(`\n  ${pc.bold(pc.yellow(plural(matches.length, "finding")))} in ${plural(files, "file")}`);
  if (fixable) console.log(`  ${pc.green(`🔧 ${fixable} can be fixed automatically:`)} ${pc.bold("bugvax fix")} ${pc.dim("(or --dry-run to preview)")}`);
  console.log();
  return 1;
}
