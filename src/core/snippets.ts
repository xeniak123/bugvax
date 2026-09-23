/** Merge overlapping or adjacent [from, to] ranges. */
export function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * Numbered excerpts of `content` around `regions` (1-based, inclusive), with the region lines
 * marked by ">". Output is capped at `maxLines` lines.
 */
export function windows(content: string, regions: [number, number][], context: number, maxLines = 220): string {
  const lines = content.split(/\r?\n/);
  const merged = mergeRanges(regions.map(([a, b]) => [a - context, b + context] as [number, number]));
  const width = String(Math.min(lines.length, merged[merged.length - 1]?.[1] ?? 1)).length;
  const marked = (n: number) => regions.some(([a, b]) => n >= a && n <= b);
  const parts: string[] = [];
  let budget = maxLines;
  for (const [f, t] of merged) {
    if (budget <= 0) {
      parts.push("  … (more omitted)");
      break;
    }
    const from = Math.max(1, f);
    const to = Math.min(lines.length, t, from + budget - 1);
    const block: string[] = [];
    for (let n = from; n <= to; n++) block.push(`${marked(n) ? ">" : " "} ${String(n).padStart(width)}| ${lines[n - 1]}`);
    parts.push(block.join("\n"));
    budget -= to - from + 1;
  }
  return parts.join("\n  …\n");
}
