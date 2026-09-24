import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { describeAntibody, describeMatches, describeOutcome, oneLine } from "./agent.js";
import { scan } from "./core/engine.js";
import { runFix } from "./core/fixer.js";
import { gitMaybe, repoRelative, repoRoot } from "./core/git.js";
import { languageOf } from "./core/languages.js";
import { learnFromSample } from "./core/learner.js";
import { sampleFromWorkingTree } from "./core/sample.js";
import { antibodyMeta, Store } from "./core/store.js";
import { createProvider } from "./llm/index.js";
import { Mutex } from "./util/proc.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const NO_ANTIBODIES = "This repository has no bugvax antibodies yet. Run `bugvax learn` to learn them from its past bug fixes.";
const HISTORY_LIMIT = 25;

/** Git Bash and MSYS hand out paths like /c/Users/...; turn them into C:/Users/... on Windows. */
function nativePath(p: string): string {
  if (process.platform !== "win32") return p;
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${m[2] ?? "/"}` : p;
}

/** The git repository containing `p` (a file or directory that may not exist yet), or null. */
async function rootOf(p: string): Promise<string | null> {
  let dir = p;
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  const out = await gitMaybe(statSync(dir).isDirectory() ? dir : dirname(dir), ["rev-parse", "--show-toplevel"]);
  return out?.trim() || null;
}

type Resolved = { rel: string } | { error: string };

/**
 * A tool path relative to the repository root, as the tool descriptions promise. Relative paths
 * are looked up from the root first and from the server's working directory second.
 */
function resolvePath(root: string, cwd: string, input: string): Resolved {
  if (input.startsWith("-")) return { error: `${input} is not a valid path` };
  const p = nativePath(input);
  if (isAbsolute(p)) {
    const rel = repoRelative(root, p, root);
    return rel === null ? { error: `${input} is outside the repository ${root}` } : { rel: rel || "." };
  }
  const fromRoot = repoRelative(root, p, root);
  if (fromRoot !== null && existsSync(join(root, fromRoot))) return { rel: fromRoot || "." };
  const fromCwd = repoRelative(root, p, cwd);
  if (fromCwd !== null && existsSync(join(root, fromCwd))) return { rel: fromCwd || "." };
  if (fromRoot === null) return { error: `${input} is outside the repository ${root}` };
  return { rel: fromRoot || "." };
}

/** The bugvax MCP server: lets any MCP-capable agent consult the repository's bug history. */
export function createMcpServer(cwd = process.cwd()): McpServer {
  const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
  const server = new McpServer({ name: "bugvax", version });

  /**
   * Which repository? BUGVAX_ROOT, then the repository of an absolute path the agent passed, then
   * the server's working directory, then the client's MCP roots (clients with a global config,
   * like Claude Desktop, do not start servers in the project directory).
   */
  async function findRoot(hint?: string): Promise<string> {
    if (process.env.BUGVAX_ROOT) return repoRoot(process.env.BUGVAX_ROOT);
    if (hint && isAbsolute(nativePath(hint))) {
      const r = await rootOf(nativePath(hint));
      if (r) return r;
    }
    const here = await rootOf(cwd);
    if (here) return here;
    if (server.server.getClientCapabilities()?.roots) {
      try {
        const { roots } = await server.server.listRoots();
        for (const r of roots) {
          if (!r.uri.startsWith("file:")) continue;
          const found = await rootOf(fileURLToPath(r.uri));
          if (found) return found;
        }
      } catch {
        /* the client does not answer roots/list */
      }
    }
    throw new Error(
      "bugvax could not find the git repository to work on. Start the MCP server inside the project, pass an absolute file path, " +
        "or set BUGVAX_ROOT=/path/to/repo in the server's environment.",
    );
  }

  async function context(hint?: string) {
    const root = await findRoot(hint);
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

  server.registerTool(
    "check_code",
    {
      title: "Check code for known bugs",
      description:
        "Check a file, or code you are about to write, against every bug this repository has already fixed before (bugvax antibodies). " +
        "Pass `content` to check code BEFORE writing it to `path` (required when the file does not exist yet). Returns each re-introduced bug " +
        "with why it is a bug, the proven fix when there is one, and the commit where it was fixed before.",
      inputSchema: {
        path: z.string().describe("File path, absolute or relative to the repository root. Its extension selects the language."),
        content: z.string().optional().describe("Code to check instead of the file on disk, e.g. the new version you are about to write."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path, content }) => {
      const { root, antibodies, globs } = await context(path);
      if (!antibodies.length) return text(NO_ANTIBODIES);
      const resolved = resolvePath(root, cwd, path);
      let rel: string;
      if ("error" in resolved) {
        if (content === undefined) return fail(`${resolved.error}. Pass \`content\` to check code that lives elsewhere.`);
        rel = basename(nativePath(path));
      } else rel = resolved.rel;
      if (!languageOf(rel)) return fail(`bugvax cannot parse ${rel} (unsupported language).`);
      const rules = antibodies.map((a) => a.doc);
      let matches;
      if (content !== undefined) {
        const dir = await mkdtemp(join(tmpdir(), "bugvax-mcp-"));
        try {
          await mkdir(dirname(join(dir, rel)), { recursive: true });
          await writeFile(join(dir, rel), content);
          matches = await scan(rules, [rel], dir, { globs });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      } else {
        if (!existsSync(join(root, rel))) return fail(`${rel} does not exist. Pass \`content\` to check code before writing it.`);
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
      const { root, antibodies } = await context(path);
      if (!antibodies.length) return text(NO_ANTIBODIES);
      const resolved = path ? resolvePath(root, cwd, path) : null;
      const rel = resolved && "rel" in resolved ? resolved.rel : null;
      const lang = path ? languageOf(path) : undefined;
      let list = lang ? antibodies.filter((a) => a.doc.language === lang.id) : antibodies;
      const words = (query ?? "").toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 2);
      if (words.length) {
        list = list.filter((a) => {
          const meta = antibodyMeta(a.doc);
          const hay = [a.doc.id, a.doc.message, a.doc.note, meta?.title, meta?.source.subject].join(" ").toLowerCase();
          return words.some((w) => hay.includes(w));
        });
      }
      const rank = (files: string[]) => (rel && files.includes(rel) ? 2 : rel && files.some((f) => dirname(f) === dirname(rel)) ? 1 : 0);
      list = [...list].sort((a, b) => rank(antibodyMeta(b.doc)?.source.files ?? []) - rank(antibodyMeta(a.doc)?.source.files ?? []));
      if (!list.length) return text("No matching bug history.");
      const more = list.length > HISTORY_LIMIT ? `\n\n… and ${list.length - HISTORY_LIMIT} more. Narrow the list with \`query\` or \`path\`.` : "";
      return text(
        `${list.length} bug class(es) this repository has fixed before${lang ? ` (${lang.label})` : ""}:\n\n` +
          `${list.slice(0, HISTORY_LIMIT).map(describeAntibody).join("\n\n")}${more}`,
      );
    },
  );

  /** Resolve a list of tool paths; any bad path is an error rather than a silently empty scan. */
  function resolveTargets(root: string, paths: string[] | undefined): { targets: string[] } | { error: string } {
    if (!paths?.length) return { targets: ["."] };
    const targets: string[] = [];
    const problems: string[] = [];
    for (const p of paths) {
      const r = resolvePath(root, cwd, p);
      if ("error" in r) problems.push(r.error);
      else if (!existsSync(join(root, r.rel))) problems.push(`${r.rel} does not exist`);
      else targets.push(r.rel);
    }
    return problems.length ? { error: problems.join("\n") } : { targets };
  }

  server.registerTool(
    "scan",
    {
      title: "Find latent copies of fixed bugs",
      description: "Scan the repository (or some paths) for code that still contains a bug this repository already fixed somewhere else.",
      inputSchema: { paths: z.array(z.string()).optional().describe("Files or directories, relative to the repository root; default: the whole repository.") },
      annotations: { readOnlyHint: true },
    },
    async ({ paths }) => {
      const { root, antibodies, globs } = await context(paths?.[0]);
      if (!antibodies.length) return text(NO_ANTIBODIES);
      const t = resolveTargets(root, paths);
      if ("error" in t) return fail(t.error);
      const matches = await scan(antibodies.map((a) => a.doc), t.targets, root, { globs });
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
        "Rewrite code in place with the proven auto-fixes (fix templates that reproduce a real past fix) for findings in the given paths. " +
        "Call it with dry_run first to preview. Findings without a proven fix are listed for a manual fix.",
      inputSchema: {
        paths: z.array(z.string()).optional().describe("Files or directories, relative to the repository root; default: the whole repository."),
        dry_run: z.boolean().optional().describe("Only show what would change."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ paths, dry_run }) => {
      const { root, antibodies, globs } = await context(paths?.[0]);
      if (!antibodies.length) return text(NO_ANTIBODIES);
      const t = resolveTargets(root, paths);
      if ("error" in t) return fail(t.error);
      const run = await runFix(antibodies.map((a) => a.doc), t.targets, root, { globs, dryRun: dry_run });
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
        "Takes one to a few minutes and uses the configured model backend; it reports progress, and cancelling the call stops it.",
      inputSchema: { description: z.string().describe("One sentence: what bug you fixed.") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ description }, extra) => {
      const { root, store, config } = await context();
      const sample = await sampleFromWorkingTree(root, description.replace(/\s+/g, " ").trim());
      if (!sample) return text("No uncommitted source changes found. Make the fix first (do not commit it yet), then call this tool.");
      await store.init();
      const llm = createProvider({ provider: config.provider, model: config.model, effort: config.effort });
      const token = extra._meta?.progressToken;
      let progress = 0;
      const onStep = (message: string) => {
        if (token === undefined) return;
        void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++progress, message } }).catch(() => {});
      };
      const outcome = await learnFromSample(sample, { root, store, llm, config, mutex: new Mutex(), onStep, signal: extra.signal });
      return text(describeOutcome(outcome));
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport());
}
