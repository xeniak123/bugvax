export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompleteJSONRequest {
  system: string;
  messages: ChatMessage[];
  /** JSON Schema the response must follow. */
  schema: Record<string, unknown>;
}

export interface CompleteJSONResult {
  json: unknown;
  /** The raw JSON text, kept so it can be replayed as the assistant turn. */
  raw: string;
  costUsd?: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  completeJSON(req: CompleteJSONRequest): Promise<CompleteJSONResult>;
}

/**
 * - `fatal`: no point in continuing the run (usage limit, billing, authentication).
 * - `transient`: this call failed (network, overload, timeout); the fix can be retried later.
 * - `model`: the model answered, but unusably (refusal, truncated output).
 */
export type LLMErrorKind = "fatal" | "transient" | "model";

export class LLMError extends Error {
  constructor(
    message: string,
    readonly kind: LLMErrorKind = "model",
  ) {
    super(message);
  }
}

const LIMIT = /(session|usage|rate|weekly|daily|monthly)[ -]limit|limit (reached|exceeded)|hit your .*limit|resets? (at )?\d|credit balance|quota|billing|insufficient/i;
const AUTH = /not logged in|please run \/login|invalid api key|authentication|unauthorized|oauth token/i;
const TRANSIENT = /overloaded|timed? ?out|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|529|503|502/i;

/** Classify a backend error message. */
export function classifyError(message: string): LLMErrorKind {
  if (LIMIT.test(message) || AUTH.test(message)) return "fatal";
  if (TRANSIENT.test(message)) return "transient";
  return "model";
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Parse a JSON object out of model text, tolerating code fences or stray prose around it. */
export function extractJSON(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new LLMError(`Model did not return JSON: ${trimmed.slice(0, 200)}`);
}
