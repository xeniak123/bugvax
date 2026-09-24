import Anthropic from "@anthropic-ai/sdk";
import { classifyError, extractJSON, LLMError, type CompleteJSONRequest, type CompleteJSONResult, type Effort, type LLMProvider } from "./types.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

/** Calls the Claude API directly. Needs ANTHROPIC_API_KEY (or another credential the SDK can find). */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly client = new Anthropic();

  constructor(
    readonly model: string = DEFAULT_ANTHROPIC_MODEL,
    private readonly effort: Effort = "high",
  ) {}

  async completeJSON(req: CompleteJSONRequest): Promise<CompleteJSONResult> {
    // Server-side fallbacks re-run a request that a safety classifier declined (security fixes can
    // look like "cyber" content) on another model, instead of failing the whole antibody.
    const useFallbacks = /^claude-(opus-5|fable-5-1)$/.test(this.model);
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        system: req.system,
        messages: req.messages,
        output_config: {
          ...(this.model.includes("haiku") ? {} : { effort: this.effort }),
          format: { type: "json_schema", schema: req.schema },
        },
        ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      } as Anthropic.Beta.MessageCreateParamsNonStreaming, { signal: req.signal });
    } catch (error) {
      if (req.signal?.aborted) throw new LLMError("cancelled", "transient");
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        throw new LLMError("Anthropic API authentication failed. Set ANTHROPIC_API_KEY, or use --provider claude-code.", "fatal");
      }
      // The SDK already retried; hammering on would only burn more of the rate limit.
      if (error instanceof Anthropic.RateLimitError) throw new LLMError("Anthropic API rate limit hit. Try again later or lower --concurrency.", "fatal");
      if (error instanceof Anthropic.NotFoundError) throw new LLMError(`Model ${this.model} not found: ${error.message}`, "fatal");
      if (error instanceof Anthropic.BadRequestError) {
        // A prompt that is too large is about this fix; anything else (model, effort, options) is setup.
        const perFix = /too long|too large|too many tokens/i.test(error.message);
        throw new LLMError(`Anthropic API rejected the request: ${error.message}`, perFix ? "model" : "fatal");
      }
      if (error instanceof Anthropic.InternalServerError) throw new LLMError(`Anthropic API error ${error.status}: ${error.message}`, "transient");
      if (error instanceof Anthropic.APIConnectionError) throw new LLMError(`Could not reach the Anthropic API: ${error.message}`, "transient");
      if (error instanceof Anthropic.APIError) throw new LLMError(`Anthropic API error ${error.status}: ${error.message}`, classifyError(error.message));
      // e.g. "Could not resolve authentication method": no key configured.
      throw new LLMError(`Anthropic client error: ${(error as Error).message}`, "fatal");
    }
    if (response.stop_reason === "refusal") throw new LLMError("The model declined to analyze this change.", "model");
    if (response.stop_reason === "max_tokens") throw new LLMError("The model ran out of output tokens.", "model");
    const raw = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { json: extractJSON(raw), raw };
  }
}
