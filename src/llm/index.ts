import { AnthropicProvider } from "./anthropic.js";
import { CachedProvider } from "./cache.js";
import { ClaudeCodeProvider, findClaudeBinary } from "./claude-code.js";
import { LLMError, type Effort, type LLMProvider } from "./types.js";

export interface ProviderOptions {
  provider: "auto" | "anthropic" | "claude-code";
  model?: string;
  effort: Effort;
}

/**
 * `auto` uses the Claude API when a key is configured, and otherwise the local Claude Code CLI,
 * so a Claude subscription is enough to run bugvax.
 */
export function createProvider(opts: ProviderOptions): LLMProvider {
  const provider = baseProvider(opts);
  return process.env.BUGVAX_LLM_CACHE ? new CachedProvider(provider, process.env.BUGVAX_LLM_CACHE) : provider;
}

function baseProvider(opts: ProviderOptions): LLMProvider {
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const choice = opts.provider === "auto" ? (hasKey ? "anthropic" : "claude-code") : opts.provider;
  if (choice === "anthropic") return new AnthropicProvider(opts.model, opts.effort);
  const bin = findClaudeBinary();
  if (!bin) {
    throw new LLMError(
      opts.provider === "auto"
        ? "No model backend found. Either set ANTHROPIC_API_KEY, or install Claude Code (https://claude.com/claude-code) and log in."
        : "Claude Code CLI (`claude`) was not found on PATH. Install it or set BUGVAX_CLAUDE_BIN.",
    );
  }
  return new ClaudeCodeProvider(bin, opts.model, opts.effort);
}

export { LLMError } from "./types.js";
export type { LLMProvider, ChatMessage, Effort } from "./types.js";
