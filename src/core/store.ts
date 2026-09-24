import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { ruleToYaml, type RuleDoc } from "./engine.js";

export const BUGVAX_DIR = ".bugvax";
export const ANTIBODY_DIR = "antibodies";

export interface AntibodyMeta {
  title: string;
  learnedAt: string;
  source: {
    kind: "commit" | "working-tree" | "vaccine";
    commit?: string;
    subject: string;
    date?: string;
    files: string[];
    /** For vaccines: the pack name and the upstream repository the antibody was learned from. */
    pack?: string;
    repo?: string;
  };
  validation: {
    firesOnBuggy: boolean;
    silentOnFixed: boolean;
    headMatches: number;
    attempts: number;
    reviewed: boolean;
    /** "proven": the rule's fix template reproduces the real fix on history. */
    fix?: "proven" | "none";
  };
}

export interface Antibody {
  path: string;
  doc: RuleDoc;
}

export function antibodyMeta(doc: RuleDoc): AntibodyMeta | undefined {
  return (doc.metadata as { bugvax?: AntibodyMeta } | undefined)?.bugvax;
}

export interface Config {
  provider: "auto" | "anthropic" | "claude-code";
  model?: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxAttempts: number;
  maxHeadMatches: number;
  review: boolean;
  /** Extra ast-grep globs, e.g. "!**\/legacy/**". */
  exclude: string[];
}

export const DEFAULT_CONFIG: Config = {
  provider: "auto",
  effort: "high",
  maxAttempts: 3,
  maxHeadMatches: 10,
  review: true,
  exclude: [],
};

export type CommitStatus = "learned" | "skipped" | "covered" | "failed";

export interface State {
  version: 1;
  commits: Record<string, { status: CommitStatus; antibody?: string; reason?: string; at: string }>;
}

export class Store {
  constructor(readonly root: string) {}

  get dir(): string {
    return join(this.root, BUGVAX_DIR);
  }

  get antibodyDir(): string {
    return join(this.dir, ANTIBODY_DIR);
  }

  exists(): boolean {
    return existsSync(this.dir);
  }

  async init(): Promise<boolean> {
    const created = !this.exists();
    await mkdir(this.antibodyDir, { recursive: true });
    if (!existsSync(join(this.dir, "config.json"))) {
      await writeFile(join(this.dir, "config.json"), JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    }
    if (!existsSync(join(this.dir, "README.md"))) {
      await writeFile(
        join(this.dir, "README.md"),
        [
          "# .bugvax",
          "",
          "Antibodies learned from this repository's bug fixes by bugvax (`npx bugvax`).",
          "",
          "- `antibodies/*.yml` are plain [ast-grep](https://ast-grep.github.io) rules. Review them like code and commit them.",
          "- `state.json` remembers which commits were already analyzed, so `bugvax learn` only looks at new history.",
          "- Delete an antibody file to remove it. Edit it freely: it is yours.",
          "",
        ].join("\n"),
      );
    }
    return created;
  }

  async config(): Promise<Config> {
    try {
      const raw = JSON.parse(await readFile(join(this.dir, "config.json"), "utf8")) as Partial<Config>;
      return { ...DEFAULT_CONFIG, ...raw };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  async antibodies(): Promise<Antibody[]> {
    if (!existsSync(this.antibodyDir)) return [];
    const files = (await readdir(this.antibodyDir)).filter((f) => /\.ya?ml$/.test(f)).sort();
    const out: Antibody[] = [];
    for (const f of files) {
      const path = join(this.antibodyDir, f);
      try {
        const doc = YAML.parse(await readFile(path, "utf8")) as RuleDoc;
        if (doc && typeof doc === "object" && doc.id && doc.rule) out.push({ path, doc });
      } catch (e) {
        throw new Error(`Invalid antibody file ${path}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  async save(doc: RuleDoc): Promise<Antibody> {
    await mkdir(this.antibodyDir, { recursive: true });
    const taken = new Set((await this.antibodies()).map((a) => a.doc.id));
    // Ids become file names, and vaccine packs are third-party input: never let one leave the directory.
    const base = safeId(doc.id);
    // Reserve file names too: an edited antibody may carry a different id than its file name.
    const files = new Set((await readdir(this.antibodyDir)).map((f) => f.toLowerCase()));
    const inUse = (x: string) => taken.has(x) || files.has(`${x}.yml`) || files.has(`${x}.yaml`);
    let id = base;
    for (let n = 2; inUse(id); n++) id = `${base}-${n}`;
    const final = { ...doc, id };
    const path = join(this.antibodyDir, `${id}.yml`);
    await writeFile(path, header(final) + ruleToYaml(final));
    return { path, doc: final };
  }

  async state(): Promise<State> {
    try {
      return JSON.parse(await readFile(join(this.dir, "state.json"), "utf8")) as State;
    } catch {
      return { version: 1, commits: {} };
    }
  }

  async saveState(state: State): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const sorted: State = { version: 1, commits: Object.fromEntries(Object.entries(state.commits).sort(([a], [b]) => a.localeCompare(b))) };
    await writeFile(join(this.dir, "state.json"), JSON.stringify(sorted, null, 2) + "\n");
  }
}

/** A file-name-safe antibody id: lowercase letters, digits and dashes. */
export function safeId(id: string): string {
  return (
    String(id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/, "") || "antibody"
  );
}

function header(doc: RuleDoc): string {
  const meta = antibodyMeta(doc);
  const lines = ["# bugvax antibody: an ast-grep rule learned from a real bug fix."];
  // One line: a newline in a commit subject or an agent's description would otherwise end the comment.
  const subject = meta?.source.subject.replace(/\s+/g, " ").trim();
  if (meta?.source.commit) lines.push(`# Source: ${meta.source.commit.slice(0, 12)} "${subject}"`);
  else if (meta) lines.push(`# Source: ${subject}`);
  return lines.join("\n") + "\n";
}
