import type { Match } from "./core/engine.js";
import type { Outcome } from "./core/learner.js";
import { antibodyMeta, type Antibody, type AntibodyMeta } from "./core/store.js";

/** Plain-text descriptions for AI agents (hook feedback and MCP tool results). */

export function oneLine(s: string, max = 160): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function describeMatches(matches: Match[], antibodies: Antibody[], limit = 50): string {
  const lines: string[] = [];
  for (const m of matches.slice(0, limit)) {
    const a = antibodies.find((x) => x.doc.id === m.ruleId);
    const meta = a ? antibodyMeta(a.doc) : undefined;
    lines.push(`${m.file}:${m.line}  [${m.ruleId}] ${m.message}`);
    lines.push(`  code: ${oneLine(m.lines.split(/\r?\n/)[0])}`);
    if (m.fix) lines.push(`  proven fix: replace \`${oneLine(m.text)}\` with \`${oneLine(m.fix.text)}\``);
    if (a?.doc.note) lines.push(`  why: ${a.doc.note}`);
    const history = meta ? historyLine(meta) : "";
    if (history) lines.push(`  history: ${history}`);
    lines.push("");
  }
  if (matches.length > limit) lines.push(`… and ${matches.length - limit} more.`);
  return lines.join("\n").trimEnd();
}

export function describeAntibody(a: Antibody): string {
  const meta = antibodyMeta(a.doc);
  const lines = [`[${a.doc.id}] ${meta?.title ?? a.doc.id} (${a.doc.language}, ${a.doc.severity ?? "error"})`, `  ${a.doc.message ?? ""}`];
  if (a.doc.note) lines.push(`  why: ${a.doc.note}`);
  if (meta) {
    const files = meta.source.kind === "commit" && meta.source.files.length ? `, in ${meta.source.files.join(", ")}` : "";
    lines.push(`  ${historyLine(meta)}${files}`);
  }
  if (a.doc.fix) lines.push("  auto-fix: yes (proven on the historical fix)");
  return lines.join("\n");
}

/** Where an antibody came from, in one line. */
export function historyLine(meta: AntibodyMeta): string {
  const s = meta.source;
  if (s.kind === "vaccine") {
    const repo = s.repo?.replace(/^https:\/\/github\.com\//, "");
    const where = repo ? ` in ${repo}${s.commit ? `@${s.commit.slice(0, 7)}` : ""}` : "";
    return `"${s.pack}" vaccine: learned from the fix${where} "${s.subject}"`;
  }
  if (s.commit) return `fixed before in ${s.commit.slice(0, 7)} "${s.subject}"`;
  return `learned from "${s.subject}"`;
}

export function describeOutcome(o: Outcome): string {
  switch (o.status) {
    case "learned": {
      const lines = [`Learned antibody "${o.antibody.doc.id}": ${o.antibody.doc.message ?? ""}`];
      if (o.antibody.doc.fix) lines.push("It carries a proven auto-fix.");
      if (o.latent.length) {
        lines.push(`The same bug is still present in ${o.latent.length} other place(s):`);
        for (const m of o.latent) lines.push(`- ${m.file}:${m.line}: ${oneLine(m.lines)}`);
      }
      return lines.join("\n");
    }
    case "covered":
      return `Already covered: the existing antibody "${o.by}" catches this bug.`;
    case "skipped":
      return `No antibody: ${o.reason}`;
    case "failed":
      return `Could not learn a reliable antibody: ${o.reason}`;
    case "interrupted":
      return `The model backend is unavailable: ${o.reason}`;
  }
}
