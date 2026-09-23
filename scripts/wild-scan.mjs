#!/usr/bin/env node
// Scan public repositories with a vaccine pack (no model calls) and print a Markdown report of
// candidate bugs for a human to verify before reporting anything upstream.
//   npm run build && node scripts/wild-scan.mjs starter psf/requests httpie/cli > wild-scan.md
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [pack, ...repos] = process.argv.slice(2);
if (!pack || !repos.length) {
  console.error("usage: node scripts/wild-scan.mjs <pack> <owner/repo> [owner/repo...]");
  process.exit(1);
}
const cli = resolve("dist/cli.js");
const vaccines = resolve("vaccines");
const work = mkdtempSync(join(tmpdir(), "bugvax-wild-"));
const env = { ...process.env, NO_COLOR: "1", GITHUB_ACTIONS: "false", BUGVAX_VACCINES_DIR: vaccines };

const out = [`# bugvax wild scan: \`${pack}\` pack`, "", "Candidates only: verify each one by hand before reporting it upstream.", ""];
let total = 0;
for (const repo of repos) {
  const dir = join(work, repo.replace("/", "__"));
  try {
    if (!existsSync(dir)) execFileSync("git", ["clone", "--quiet", "--depth", "1", `https://github.com/${repo}.git`, dir], { stdio: "ignore" });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
    execFileSync(process.execPath, [cli, "vaccinate", pack], { cwd: dir, env, stdio: "ignore" });
    let json = "[]";
    try {
      json = execFileSync(process.execPath, [cli, "scan", "--json"], { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 }).toString();
    } catch (e) {
      json = e.stdout?.toString() || "[]"; // scan exits 1 when it finds something
    }
    const matches = JSON.parse(json);
    total += matches.length;
    out.push(`## [${repo}](https://github.com/${repo}) · ${matches.length} candidate(s)`, "");
    for (const m of matches.slice(0, 25)) {
      const url = `https://github.com/${repo}/blob/${sha}/${m.file}#L${m.line}`;
      out.push(`- [\`${m.file}:${m.line}\`](${url}) **${m.ruleId}**: \`${m.lines.trim().slice(0, 120)}\``);
      if (m.fix) out.push(`  - proven fix: \`${m.fix.text.replace(/\s+/g, " ").slice(0, 140)}\``);
    }
    if (matches.length > 25) out.push(`- … ${matches.length - 25} more`);
    out.push("");
  } catch (e) {
    out.push(`## ${repo}`, "", `Could not scan: ${String(e.message).split("\n")[0]}`, "");
  }
}
out.push(`**${total} candidate(s) in ${repos.length} repositories.**`);
console.log(out.join("\n"));
