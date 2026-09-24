export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompleteJSONRequest {
  system: string;
  messages: ChatMessage[];
  /** JSON Schema the response must follow. */
  schema: Record<string, unknown>;
  /** Cancels the call (e.g. an MCP client gave up on the tool call). */
  signal?: AbortSignal;
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

const LIMIT =
  /(session|usage|rate|weekly|daily|monthly)[ -]limit|limit (reached|exceeded)|hit your .*(limit|budget)|reached your .*limit|resets? (at )?\d|credit balance|quota|billing|insufficient|out of (extra )?usage|usage credits|usage allocation|shared budget|add funds/i;
const AUTH = /not logged in|please run \/login|invalid api key|authentication|unauthorized|oauth token/i;
const SETUP = /issue with the selected model|may not exist|model .*not found|not_found_error|unknown option|unknown argument/i;
const TRANSIENT =
  /overloaded|timed? ?out|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|unable to connect|connection (refused|dropped|error)|internet|server-side issue|internal server error|\b5\d\d\b/i;

/** Classify a backend error message. */
export function classifyError(message: string): LLMErrorKind {
  if (LIMIT.test(message) || AUTH.test(message) || SETUP.test(message)) return "fatal";
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
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  throw new LLMError(`Model did not return JSON: ${trimmed.slice(0, 200)}`);
}
