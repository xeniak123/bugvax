import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { checkRule, ruleToYaml, type RuleDoc } from "./engine.js";
import { antibodyMeta, type Antibody, type AntibodyMeta, type Store } from "./store.js";

/**
 * Vaccines are packs of antibodies learned from the bug-fix history of public projects, shipped
 * with bugvax so a repository can be protected before it has any history of its own.
 */
export interface PackInfo {
  name: string;
  description: string;
  languages: string[];
  /** Upstream repositories the antibodies were learned from. */
  sources: { repo: string; fixesAnalyzed?: number }[];
}

export interface Pack extends PackInfo {
  dir: string;
  antibodies: RuleDoc[];
}

export function vaccinesDir(): string {
  return process.env.BUGVAX_VACCINES_DIR ?? fileURLToPath(new URL("../../vaccines/", import.meta.url));
}

export async function listPacks(dir = vaccinesDir()): Promise<Pack[]> {
  if (!existsSync(dir)) return [];
  const packs: Pack[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const pack = await loadPack(entry, dir);
    if (pack) packs.push(pack);
  }
  return packs;
}

export async function loadPack(name: string, dir = vaccinesDir()): Promise<Pack | null> {
  const packDir = join(dir, name);
  if (!existsSync(join(packDir, "pack.json"))) return null;
  const info = JSON.parse(await readFile(join(packDir, "pack.json"), "utf8")) as PackInfo;
  const abDir = join(packDir, "antibodies");
  const antibodies: RuleDoc[] = [];
  if (existsSync(abDir)) {
    for (const f of (await readdir(abDir)).filter((x) => /\.ya?ml$/.test(x)).sort()) {
      antibodies.push(YAML.parse(await readFile(join(abDir, f), "utf8")) as RuleDoc);
    }
  }
  return { ...info, name: info.name ?? name, dir: packDir, antibodies };
}

export interface VaccinationResult {
  added: Antibody[];
  alreadyPresent: string[];
  invalid: { id: string; error: string }[];
}

/** Copy a pack's antibodies into the repository's store, skipping ones it already has. */
export async function vaccinate(store: Store, pack: Pack): Promise<VaccinationResult> {
  const existing = await store.antibodies();
  const known = new Set(existing.map((a) => fingerprint(a.doc)));
  const result: VaccinationResult = { added: [], alreadyPresent: [], invalid: [] };
  for (const doc of pack.antibodies) {
    if (known.has(fingerprint(doc))) {
      result.alreadyPresent.push(doc.id);
      continue;
    }
    const error = await checkRule(doc);
    if (error) {
      result.invalid.push({ id: doc.id, error });
      continue;
    }
    const meta = antibodyMeta(doc);
    const source: AntibodyMeta["source"] = {
      ...(meta?.source ?? { subject: doc.id, files: [] }),
      kind: "vaccine",
      pack: pack.name,
    };
    const saved = await store.save({ ...doc, metadata: { ...(doc.metadata ?? {}), bugvax: { ...(meta ?? {}), source } } });
    known.add(fingerprint(doc));
    result.added.push(saved);
  }
  return result;
}

/** Two antibodies are the same if they match the same code the same way. */
function fingerprint(doc: RuleDoc): string {
  return JSON.stringify([doc.language, doc.rule, doc.constraints ?? null, doc.utils ?? null]);
}

/** Maintainer tool: export a repository's learned antibodies as a vaccine pack. */
export async function exportPack(antibodies: Antibody[], out: string, info: PackInfo): Promise<number> {
  await mkdir(join(out, "antibodies"), { recursive: true });
  let n = 0;
  for (const a of antibodies) {
    const meta = antibodyMeta(a.doc);
    const source = { ...(meta?.source ?? { subject: a.doc.id, files: [] }), repo: info.sources[0]?.repo };
    const doc: RuleDoc = { ...a.doc, metadata: { ...(a.doc.metadata ?? {}), bugvax: { ...(meta ?? {}), source } } };
    await writeFile(join(out, "antibodies", `${a.doc.id}.yml`), ruleToYaml(doc));
    n++;
  }
  const packFile = join(out, "pack.json");
  let current: PackInfo | null = null;
  if (existsSync(packFile)) current = JSON.parse(await readFile(packFile, "utf8")) as PackInfo;
  const merged: PackInfo = {
    name: info.name,
    description: info.description || current?.description || "",
    languages: [...new Set([...(current?.languages ?? []), ...info.languages])].sort(),
    sources: [...(current?.sources ?? []).filter((s) => !info.sources.some((x) => x.repo === s.repo)), ...info.sources],
  };
  await writeFile(packFile, JSON.stringify(merged, null, 2) + "\n");
  return n;
}
