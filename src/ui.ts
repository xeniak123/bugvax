import pc from "picocolors";
import type { Match } from "./core/engine.js";
import { antibodyMeta, type Antibody } from "./core/store.js";

export { pc };

export function header(title: string, sub?: string): void {
  console.log(`\n${pc.bold(`🧬 bugvax ${title}`)}${sub ? pc.dim(`  ${sub}`) : ""}`);
}

export function loc(m: Pick<Match, "file" | "line">): string {
  return pc.cyan(`${m.file}:${m.line}`);
}

export function codeLine(s: string, max = 90): string {
  const t = s.split(/\r?\n/)[0].trim();
  return pc.dim(t.length > max ? t.slice(0, max) + "…" : t);
}

export function provenance(a: Antibody | undefined): string {
  const meta = a ? antibodyMeta(a.doc) : undefined;
  if (!meta) return "";
  if (meta.source.kind === "vaccine") return `💉 ${meta.source.pack} vaccine`;
  if (meta.source.commit) return `learned from ${meta.source.commit.slice(0, 7)} "${meta.source.subject}"`;
  return `learned from "${meta.source.subject}"`;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Terminal width, or a readable default when output is piped. */
export function termWidth(): number {
  return process.stdout.columns || Number(process.env.COLUMNS) || 100;
}

/** The first sentence of a model-written explanation, capped for one terminal line. */
export function firstSentence(s: string, max = 140): string {
  const t = (/^[\s\S]*?(?<!\be\.g|\bi\.e|\betc|\bvs)[.;](\s|$)/.exec(s)?.[0] ?? s).replace(/\s+/g, " ").trim().replace(/[.;]$/, "");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/**
 * A single live status line for work in flight (TTY only). Call `log` instead of console.log
 * while it is active so finished results print above the status line.
 */
export class Progress {
  private readonly active = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private readonly tty = !!process.stdout.isTTY && !process.env.CI;

  start(): void {
    if (this.tty) this.timer = setInterval(() => this.render(), 120);
  }

  set(key: string, status: string): void {
    this.active.set(key, status);
  }

  delete(key: string): void {
    this.active.delete(key);
  }

  log(line: string): void {
    this.clear();
    console.log(line);
    this.render();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.clear();
  }

  private clear(): void {
    if (this.tty) process.stdout.write("\r\x1b[K");
  }

  private render(): void {
    if (!this.tty || !this.active.size) return;
    const spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[this.frame++ % 10];
    const items = [...this.active].map(([k, s]) => `${k} ${s}`).join(" · ");
    const width = (process.stdout.columns || 100) - 4;
    const text = `${spin} ${items}`;
    process.stdout.write(`\r\x1b[K${pc.dim(text.length > width ? text.slice(0, width - 1) + "…" : text)}`);
  }
}

/** In GitHub Actions, also emit annotations so findings show up inline on the pull request. */
export function githubAnnotations(matches: Match[], antibodies: Antibody[]): void {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const prop = (s: string) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
  for (const m of matches) {
    const a = antibodies.find((x) => x.doc.id === m.ruleId);
    const level = (a?.doc.severity ?? m.severity) === "warning" ? "warning" : "error";
    const body = [m.message, a?.doc.note, provenance(a)].filter(Boolean).join("\n");
    console.log(`::${level} file=${prop(m.file)},line=${m.line},endLine=${m.endLine},title=${prop(`bugvax: ${m.ruleId}`)}::${esc(body)}`);
  }
}

/** Print matches grouped by antibody, with where each antibody came from. */
export function printFindings(matches: Match[], antibodies: Antibody[]): void {
  const byRule = new Map<string, Match[]>();
  for (const m of matches) byRule.set(m.ruleId, [...(byRule.get(m.ruleId) ?? []), m]);
  for (const [ruleId, ms] of byRule) {
    const a = antibodies.find((x) => x.doc.id === ruleId);
    const sev = (a?.doc.severity ?? ms[0].severity) === "warning" ? pc.yellow("warning") : pc.red("error");
    const room = termWidth() - 4;
    console.log(`\n  ${sev} ${pc.bold(ruleId)}  ${pc.dim(truncate(provenance(a), Math.max(20, room - ruleId.length - 8)))}`);
    console.log(`  ${firstSentence(ms[0].message, room)}`);
    for (const m of ms) {
      const tag = m.fix ? "  🔧 auto-fix" : "";
      console.log(`    ${loc(m)}  ${codeLine(m.lines, Math.max(20, room - `${m.file}:${m.line}`.length - tag.length - 4))}${pc.green(tag)}`);
    }
    const note = a?.doc.note ?? ms[0].note;
    if (note) console.log(pc.dim(`    ↳ ${firstSentence(note, room - 4)}`));
  }
}
