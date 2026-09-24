import { scan } from "../core/engine.js";
import { repoRoot } from "../core/git.js";
import { Store } from "../core/store.js";
import { exportPack, listPacks, loadPack, vaccinate } from "../core/vaccines.js";
import { header, pc, plural } from "../ui.js";

/** `bugvax vaccinate` lists the bundled packs; `bugvax vaccinate react python` installs them. */
export async function vaccinateCommand(names: string[]): Promise<number> {
  if (!names.length) {
    const packs = await listPacks();
    header("vaccines", plural(packs.length, "pack"));
    if (!packs.length) {
      console.log(pc.dim("\n  No vaccine packs are bundled with this version yet."));
      return 0;
    }
    for (const p of packs) {
      const from = p.sources.map((s) => s.repo.replace(/^https:\/\/github\.com\//, "")).join(", ");
      console.log(`\n  ${pc.bold(p.name)}  ${pc.dim(`${plural(p.antibodies.length, "antibody", "antibodies")} · ${p.languages.join(", ")}`)}`);
      console.log(`  ${p.description}`);
      if (from) console.log(pc.dim(`  learned from: ${from}`));
    }
    console.log(`\n  Install with ${pc.bold("bugvax vaccinate <pack> [pack...]")}\n`);
    return 0;
  }

  const root = await repoRoot(process.cwd());
  const packs = [];
  for (const name of names) {
    const pack = await loadPack(name);
    if (!pack) {
      const known = (await listPacks()).map((p) => p.name);
      console.error(pc.red(`bugvax: unknown vaccine pack "${name}"${known.length ? ` (available: ${known.join(", ")})` : ""}`));
      return 1;
    }
    packs.push(pack);
  }
  const store = new Store(root);
  await store.init();
  header("vaccinate", root);
  let added = 0;
  for (const pack of packs) {
    const res = await vaccinate(store, pack);
    added += res.added.length;
    console.log(`\n  ${pc.green("💉")} ${pc.bold(pack.name)}: ${plural(res.added.length, "new antibody", "new antibodies")}` +
      (res.alreadyPresent.length ? pc.dim(` · ${res.alreadyPresent.length} already present`) : ""));
    for (const a of res.added) console.log(pc.dim(`     + ${a.doc.id}: ${a.doc.message ?? ""}`));
    for (const bad of res.invalid) console.log(pc.yellow(`     ! skipped ${bad.id}: not supported by this ast-grep version`));
  }
  if (added) {
    const globs = (await store.config()).exclude.map((g) => (g.startsWith("!") ? g : `!${g}`));
    const matches = await scan((await store.antibodies()).map((a) => a.doc), ["."], root, { globs });
    console.log(
      matches.length
        ? pc.yellow(`\n  ⚠ ${plural(matches.length, "finding")} in your code already. Run ${pc.bold("bugvax scan")} to see them.\n`)
        : pc.green("\n  ✓ No findings in your code. You are now protected against these bug classes.\n"),
    );
  }
  return 0;
}

/** Maintainer command: export this repository's antibodies as a vaccine pack. */
export async function exportPackCommand(name: string, opts: { out: string; repo: string; description?: string; fixes?: string }): Promise<number> {
  const root = await repoRoot(process.cwd());
  const antibodies = await new Store(root).antibodies();
  if (!antibodies.length) {
    console.error("No antibodies to export. Run `bugvax learn` first.");
    return 1;
  }
  const n = await exportPack(antibodies, opts.out, {
    name,
    description: opts.description ?? "",
    languages: [...new Set(antibodies.map((a) => a.doc.language))],
    sources: [{ repo: opts.repo, ...(opts.fixes ? { fixesAnalyzed: Number(opts.fixes) } : {}) }],
  });
  console.log(`Exported ${plural(n, "antibody", "antibodies")} to ${opts.out}`);
  return 0;
}
