import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { run } from "../util/proc.js";
import { classifyError, extractJSON, LLMError, type ChatMessage, type CompleteJSONRequest, type CompleteJSONResult, type Effort, type LLMProvider } from "./types.js";

/**
 * Locate the Claude Code CLI. On Windows the npm shim is a .cmd file, which Node cannot spawn
 * without a shell, so we read the real executable path out of it.
 */
export function findClaudeBinary(): string | null {
  if (process.env.BUGVAX_CLAUDE_BIN) return process.env.BUGVAX_CLAUDE_BIN;
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (process.platform !== "win32") {
    for (const d of dirs) if (existsSync(join(d, "claude"))) return join(d, "claude");
    return null;
  }
  for (const d of dirs) {
    const exe = join(d, "claude.exe");
    if (existsSync(exe)) return exe;
    const cmd = join(d, "claude.cmd");
    if (existsSync(cmd)) {
      const m = /"%dp0%\\([^"]+?\.exe)"/i.exec(readFileSync(cmd, "utf8"));
      if (m && existsSync(join(dirname(cmd), m[1]))) return join(dirname(cmd), m[1]);
    }
  }
  return null;
}

/**
 * Uses the Claude Code CLI (`claude -p`) as the model backend, so anyone with a Claude
 * subscription can run bugvax without an API key. Runs with no tools, no MCP servers, no hooks
 * and no CLAUDE.md, so the call is a plain completion.
 */
export class ClaudeCodeProvider implements LLMProvider {
  readonly name = "claude-code";

  constructor(
    private readonly bin: string,
    readonly model: string = "default",
    private readonly effort?: Effort,
  ) {}

  async completeJSON(req: CompleteJSONRequest): Promise<CompleteJSONResult> {
    const dir = await mkdtemp(join(tmpdir(), "bugvax-claude-"));
    try {
      const systemFile = join(dir, "system.md");
      await writeFile(systemFile, req.system);
      const args = [
        "-p",
        "--safe-mode",
        "--tools",
        "",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(req.schema),
        "--system-prompt-file",
        systemFile,
      ];
      if (this.model !== "default") args.push("--model", this.model);
      if (this.effort) args.push("--effort", this.effort);
      const env = { ...process.env };
      delete env.CLAUDECODE; // allow running from inside a Claude Code session
      let res;
      try {
        res = await run(this.bin, args, { cwd: dir, input: flatten(req.messages), env, timeoutMs: 20 * 60_000, signal: req.signal });
      } catch (e) {
        throw new LLMError(`claude -p did not finish: ${(e as Error).message}`, "transient");
      }
      let out: ClaudeCodeResult;
      try {
        out = JSON.parse(res.stdout) as ClaudeCodeResult;
      } catch {
        // No JSON at all: Claude Code did not run a model turn (crash, unsupported flag, broken install).
        const detail = (res.stderr || res.stdout).trim().slice(0, 500);
        const hint = /unknown option/i.test(detail) ? " (update Claude Code: bugvax needs version 2.1.169 or newer)" : "";
        throw new LLMError(`claude -p failed (exit ${res.code}): ${detail}${hint}`, classifyError(detail) === "transient" ? "transient" : "fatal");
      }
      if (out.subtype === "error_max_structured_output_retries") {
        throw new LLMError("Claude Code could not produce a valid structured answer.", "model");
      }
      if (out.is_error || out.subtype !== "success") {
        // An error result (offline, API error, usage) is about the backend, not this fix.
        const detail = String(out.result ?? out.subtype).slice(0, 500);
        const kind = classifyError(detail);
        throw new LLMError(`Claude Code: ${detail}`, kind === "model" ? "transient" : kind);
      }
      if (out.structured_output && typeof out.structured_output === "object") {
        return { json: out.structured_output, raw: JSON.stringify(out.structured_output), costUsd: out.total_cost_usd };
      }
      const raw = String(out.result ?? "");
      return { json: extractJSON(raw), raw, costUsd: out.total_cost_usd };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

interface ClaudeCodeResult {
  type: string;
  subtype: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
}

/** `claude -p` takes a single prompt, so earlier turns are replayed as a transcript. */
function flatten(messages: ChatMessage[]): string {
  if (messages.length === 1) return messages[0].content;
  const earlier = messages.slice(0, -1).map((m) => `<turn role="${m.role}">\n${m.content}\n</turn>`);
  const last = messages[messages.length - 1];
  return [
    "Earlier turns of this conversation:",
    "",
    ...earlier,
    "",
    "Respond to this latest message, taking the earlier turns into account:",
    "",
    last.content,
  ].join("\n");
}
