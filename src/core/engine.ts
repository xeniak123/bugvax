import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { run } from "../util/proc.js";
import { TSX_GLOBS } from "./languages.js";

/** An ast-grep rule, as stored in `.bugvax/antibodies/*.yml`. */
export interface RuleDoc {
  id: string;
  language: string;
  severity?: string;
  message?: string;
  note?: string;
  rule: unknown;
  constraints?: unknown;
  utils?: unknown;
  transform?: unknown;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Match {
  ruleId: string;
  /** Path relative to the scan's cwd, with forward slashes. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** 1-based. */
  column: number;
  text: string;
  lines: string;
  message: string;
  note?: string;
  severity: string;
  metadata?: Record<string, unknown>;
}

export class EngineError extends Error {}

function platformPackage(): string | null {
  const { platform, arch } = process;
  if (platform === "win32") {
    if (arch === "x64") return "@ast-grep/cli-win32-x64-msvc";
    if (arch === "arm64") return "@ast-grep/cli-win32-arm64-msvc";
    if (arch === "ia32") return "@ast-grep/cli-win32-ia32-msvc";
  } else if (platform === "darwin") {
    if (arch === "arm64") return "@ast-grep/cli-darwin-arm64";
    if (arch === "x64") return "@ast-grep/cli-darwin-x64";
  } else if (platform === "linux") {
    if (arch === "arm64") return "@ast-grep/cli-linux-arm64-gnu";
    if (arch === "x64") return "@ast-grep/cli-linux-x64-gnu";
  }
  return null;
}

let cachedBinary: string | null = null;

/**
 * Locate the ast-grep binary. We resolve the platform package directly instead of relying on
 * @ast-grep/cli's postinstall script, which newer npm versions block by default.
 */
export function astGrepBinary(): string {
  if (cachedBinary) return cachedBinary;
  if (process.env.BUGVAX_AST_GREP) return (cachedBinary = process.env.BUGVAX_AST_GREP);
  const exe = process.platform === "win32" ? "ast-grep.exe" : "ast-grep";
  const require = createRequire(import.meta.url);
  const pkg = platformPackage();
  const candidates: string[] = [];
  if (pkg) {
    try {
      const cliPkg = require.resolve("@ast-grep/cli/package.json");
      candidates.push(join(dirname(createRequire(cliPkg).resolve(`${pkg}/package.json`)), exe));
    } catch {
      /* not installed next to @ast-grep/cli */
    }
    try {
      candidates.push(join(dirname(require.resolve(`${pkg}/package.json`)), exe));
    } catch {
      /* not hoisted */
    }
  }
  if (process.platform !== "win32") {
    try {
      candidates.push(join(dirname(require.resolve("@ast-grep/cli/package.json")), exe));
    } catch {
      /* ignore */
    }
  }
  const found = candidates.find((p) => existsSync(p));
  return (cachedBinary = found ?? exe);
}

export function sgConfig(ruleDir = "rules"): string {
  return YAML.stringify({ ruleDirs: [ruleDir], languageGlobs: { tsx: TSX_GLOBS } });
}

export function ruleToYaml(rule: RuleDoc): string {
  return YAML.stringify(rule, { lineWidth: 0 });
}

interface RawMatch {
  text: string;
  file: string;
  lines: string;
  ruleId: string;
  severity: string;
  message: string;
  note?: string | null;
  metadata?: Record<string, unknown> | null;
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
}

function toMatch(raw: RawMatch): Match {
  return {
    ruleId: raw.ruleId,
    file: raw.file.replace(/\\/g, "/").replace(/^\.\//, ""),
    line: raw.range.start.line + 1,
    endLine: raw.range.end.line + 1,
    column: raw.range.start.column + 1,
    text: raw.text,
    lines: raw.lines,
    message: raw.message,
    note: raw.note ?? undefined,
    severity: raw.severity,
    metadata: raw.metadata ?? undefined,
  };
}

export interface ScanOptions {
  /** Extra `--globs` patterns, e.g. "!**\/legacy/**". */
  globs?: string[];
}

/**
 * Run `rules` over `targets` (files or directories, relative to `cwd`). Each rule is written to a
 * throwaway ast-grep project so that one call can scan many rules at once.
 */
export async function scan(rules: RuleDoc[], targets: string[], cwd: string, opts: ScanOptions = {}): Promise<Match[]> {
  if (!rules.length || !targets.length) return [];
  const dir = await mkdtemp(join(tmpdir(), "bugvax-rules-"));
  try {
    await mkdir(join(dir, "rules"));
    await writeFile(join(dir, "sgconfig.yml"), sgConfig());
    await Promise.all(rules.map((r, i) => writeFile(join(dir, "rules", `r${i}.yml`), ruleToYaml(r))));
    const matches: Match[] = [];
    // Keep command lines short (Windows caps them at ~32k characters).
    for (let i = 0; i < targets.length; i += 150) {
      const batch = targets.slice(i, i + 150);
      const args = ["scan", "-c", join(dir, "sgconfig.yml"), "--json=stream", "--include-metadata"];
      for (const g of opts.globs ?? []) args.push("--globs", g);
      args.push(...batch);
      const res = await run(astGrepBinary(), args, { cwd });
      const parsed: Match[] = [];
      for (const line of res.stdout.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        parsed.push(toMatch(JSON.parse(t) as RawMatch));
      }
      if (res.code !== 0 && !/found in code/i.test(res.stderr) && parsed.length === 0) {
        throw new EngineError(cleanError(res.stderr || res.stdout));
      }
      matches.push(...parsed);
    }
    return dedupe(matches);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function dedupe(matches: Match[]): Match[] {
  const seen = new Set<string>();
  return matches.filter((m) => {
    const k = `${m.ruleId}\0${m.file}\0${m.line}\0${m.column}\0${m.text.length}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function cleanError(s: string): string {
  const text = s
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/[A-Za-z]:\\[^\s]*bugvax-rules-[^\s\\/]*[\\/]rules[\\/]r\d+\.yml/g, "<rule>")
    .replace(/\/[^\s]*bugvax-rules-[^\s/]*\/rules\/r\d+\.yml/g, "<rule>")
    .replace(/rules[\\/]r\d+\.yml/g, "<rule>")
    .trim();
  return text.length > 1500 ? text.slice(0, 1500) + "…" : text;
}

/** Check that a rule compiles, without scanning anything meaningful. Returns an error message or null. */
export async function checkRule(rule: RuleDoc): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "bugvax-check-"));
  try {
    const probe = join(dir, "probe");
    await mkdir(probe);
    await writeFile(join(probe, "empty.txt"), "");
    await scan([rule], ["probe"], dir);
    return null;
  } catch (e) {
    if (e instanceof EngineError) return e.message;
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
