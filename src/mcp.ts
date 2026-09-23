import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { describeAntibody, describeMatches, describeOutcome, oneLine } from "./agent.js";
import { scan } from "./core/engine.js";
import { runFix } from "./core/fixer.js";
import { repoRelative, repoRoot } from "./core/git.js";
import { languageOf } from "./core/languages.js";
import { learnFromSample } from "./core/learner.js";
import { sampleFromWorkingTree } from "./core/sample.js";
import { antibodyMeta, Store } from "./core/store.js";
import { createProvider } from "./llm/index.js";
import { Mutex } from "./util/proc.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const NO_ANTIBODIES = "This repository has no bugvax antibodies yet. Run `bugvax learn` to learn them from its past bug fixes.";

async function context(cwd: string) {
  const root = await repoRoot(process.env.BUGVAX_ROOT ?? cwd);
  const store = new Store(root);
  const config = await store.config();
  return {
    root,
    store,
    config,
    antibodies: await store.antibodies(),
    globs: config.exclude.map((g) => (g.startsWith("!") ? g : `!${g}`)),
  };
}

/** The bugvax MCP server: lets any MCP-capable agent consult the repository's bug history. */
export function createMcpServer(cwd = process.cwd()): McpServer {
  const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
  const server = new McpServer({ name: "bugvax", version });

  server.registerTool(
    "check_code",
    {
      title: "Check code for known bugs",
      description:
        "Check a file, or code you are about to write, against every bug this repository has already fixed before (bugvax antibodies). " +
        "Pass `content` to check code BEFORE writing it to `path`. Returns each re-introduced bug with why it is a bug, " +
        "the proven fix when there is one, and the commit where it was fixed before.",
      inputSchema: {
        path: z.string().describe("File path, absolute or relative to the repository root. Its extension selects the language."),
        content: z.string().optional().describe("Code to check instead of the file on disk, e.g. the new version you are about to write."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path, content }) => {
      const { root, antibodies, globs } = await context(cwd);
      if (!antibodies.length) return text(NO_ANTIBODIES);
      const rel = repoRelative(root, path, cwd) ?? basename(path);
      if (!languageOf(rel)) return text(`bugvax cannot parse ${rel} (unsupported language).`);
      const rules = antibodies.map((a) => a.doc);
      let matches;
      if (content !== undefined) {
        const dir = await mkdtemp(join(tmpdir(), "bugvax-mcp-"));
        try {
          await mkdir(dirname(join(dir, rel)), { recursive: true });
          await writeFile(join(dir, rel), content);
          matches = await scan(rules, [rel], dir);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      } else {
        matches = await scan(rules, [rel], root, { globs });
      }
      if (!matches.length) return text(`No known bugs in ${rel} (${antibodies.length} antibodies checked).`);
      return text(`${rel} contains ${matches.length} bug(s) this repository fixed before:\n\n${describeMatches(matches, antibodies)}`);
    },
  );

  server.registerTool(
    "bug_history",
    {
      title: "Bugs fixed here before",
      description:
        "What went wrong in this codebase before? Lists the bug classes learned from past bug fixes that are relevant to a file or topic: " +
        "what the bug was, how it was fixed, and in which commit. Call it before changing unfamiliar code.",
      inputSchema: {
        path: z.string().optional().describe("A file you are about to edit; narrows the list to its language and ranks bugs from that file first."),
        query: z.string().optional().describe("Words to search for, e.g. 'await commit' or 'timeout'."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path, query }) => {
      const { root, antibodies } = await context(cwd);
      if (!antibodies.length) return text(NO_ANTIBODIES);
      const rel = path ? repoRelative(root, path, cwd) : null;
      const lang = path ? languageOf(path) : undefined;
      let list = lang ? antibodies.filter((a) => a.doc.language === lang.id) : antibodies;
      if (query) {
        const words = query.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2);
        list = list.filter((a) => {
          const meta = antibodyMeta(a.doc);
          const hay = [a.doc.id, a.doc.message, a.doc.note, meta?.title, meta?.source.subject].join(" ").toLowerCase();
          return words.some((w) => hay.includes(w));
        });
      }
      const rank = (files: string[]) => (rel && files.includes(rel) ? 2 : rel && files.some((f) => dirname(f) === dirname(rel)) ? 1 : 0);
      list = [...list].sort((a, b) => rank(antibodyMeta(b.doc)?.source.files ?? []) - rank(antibodyMeta(a.doc)?.source.files ?? [])).slice(0, 25);
      if (!list.length) return text("No matching bug history.");
      return text(`${list.length} bug class(es) this repository has fixed before${lang ? ` (${lang.label})` : ""}:\n\n${list.map(describeAntibody).join("\n\n")}`);
    },
  );

  server.registerTool(
    "scan",
    {
      title: "Find latent copies of fixed bugs",
      description: "Scan the repository (or some paths) for code that still contains a bug this repository already fixed somewhere else.",
      inputSchema: { paths: z.array(z.string()).optional().describe("Files or directories; default: the whole repository.") },
      annotations: { readOnlyHint: true },
    },
    async ({ paths }) => {
      const { root, antibodies, globs } = await context(cwd);
      if (!antibodies.length) return text(NO_ANTIBODIES);
      const targets = paths?.length ? paths.map((p) => repoRelative(root, p, cwd)).filter((p): p is string => p !== null) : ["."];
      const matches = await scan(antibodies.map((a) => a.doc), targets, root, { globs });
      if (!matches.length) return text(`No known bugs found (${antibodies.length} antibodies checked).`);
      const fixable = matches.filter((m) => m.fix).length;
      const tail = fixable ? `\n\n${fixable} of them have a proven auto-fix; the \`fix\` tool can apply it.` : "";
      return text(`${matches.length} finding(s):\n\n${describeMatches(matches, antibodies)}${tail}`);
    },
  );

  server.registerTool(
    "fix",
    {
      title: "Apply proven fixes",
      description:
        "Apply the proven auto-fixes (fix templates that reproduce a real past fix) to findings in the given paths. " +
        "Use dry_run to preview. Findings without a proven fix are listed for a manual fix.",
      inputSchema: {
        paths: z.array(z.string()).optional().describe("Files or directories; default: the whole repository."),
        dry_run: z.boolean().optional().describe("Only show what would change."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ paths, dry_run }) => {
      const { root, antibodies, globs } = await context(cwd);
      if (!antibodies.length) return text(NO_ANTIBODIES);
      const targets = paths?.length ? paths.map((p) => repoRelative(root, p, cwd)).filter((p): p is string => p !== null) : ["."];
      const run = await runFix(antibodies.map((a) => a.doc), targets, root, { globs, dryRun: dry_run });
      if (!run.found.length) return text("Nothing to fix.");
      const changes = (dry_run ? run.found.filter((m) => m.fix) : run.applied).map(
        (m) => `- ${m.file}:${m.line} [${m.ruleId}]: \`${oneLine(m.text, 80)}\` -> \`${oneLine(m.fix!.text, 80)}\``,
      );
      const manual = run.remaining.filter((m) => !m.fix).map((m) => `- ${m.file}:${m.line} [${m.ruleId}] ${m.message}`);
      const parts = [dry_run ? `Would apply ${changes.length} fix(es):` : `Applied ${changes.length} fix(es):`, ...changes];
      if (manual.length) parts.push("", "Needs a manual fix (no proven auto-fix):", ...manual);
      return text(parts.join("\n"));
    },
  );

  server.registerTool(
    "learn_from_fix",
    {
      title: "Turn the bug you just fixed into an antibody",
      description:
        "Call this right after you fixed a bug, while the fix is still uncommitted. bugvax compares HEAD (buggy) with the working tree (fixed) " +
        "and learns a validated rule that blocks this bug class from now on. It also reports other places with the same bug. " +
        "Takes a minute or two and uses the configured model backend.",
      inputSchema: { description: z.string().describe("One sentence: what bug you fixed.") },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ description }) => {
      const { root, store, config } = await context(cwd);
      const sample = await sampleFromWorkingTree(root, description);
      if (!sample) return text("No uncommitted source changes found. Make the fix first (do not commit it yet), then call this tool.");
      await store.init();
      const llm = createProvider({ provider: config.provider, model: config.model, effort: config.effort });
      const outcome = await learnFromSample(sample, { root, store, llm, config, mutex: new Mutex() });
      return text(describeOutcome(outcome));
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport());
}
