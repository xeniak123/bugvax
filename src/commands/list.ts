import { relative } from "node:path";
import { repoRoot } from "../core/git.js";
import { antibodyMeta, Store } from "../core/store.js";
import { header, pc, plural } from "../ui.js";

export async function listCommand(opts: { json?: boolean }): Promise<number> {
  const root = await repoRoot(process.cwd());
  const antibodies = await new Store(root).antibodies();
  if (opts.json) {
    console.log(JSON.stringify(antibodies.map((a) => ({ ...a.doc, file: relative(root, a.path).replace(/\\/g, "/") })), null, 2));
    return 0;
  }
  header("antibodies", plural(antibodies.length, "antibody", "antibodies"));
  if (!antibodies.length) {
    console.log(pc.dim("\n  None yet. Run `bugvax learn`."));
    return 0;
  }
  for (const a of antibodies) {
    const meta = antibodyMeta(a.doc);
    const src = meta?.source.commit ? meta.source.commit.slice(0, 7) : meta?.source.kind === "working-tree" ? "wip" : "manual";
    console.log(`\n  ${pc.bold(a.doc.id)}  ${pc.dim(`${a.doc.language} · ${a.doc.severity ?? "error"} · ${src}`)}`);
    console.log(`  ${a.doc.message ?? ""}`);
    if (meta) console.log(pc.dim(`  from: "${meta.source.subject}"`));
  }
  console.log();
  return 0;
}
