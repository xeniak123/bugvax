import YAML from "yaml";
import type { ChatMessage, LLMProvider } from "../llm/types.js";
import { LLMError } from "../llm/types.js";
import type { Mutex } from "../util/proc.js";
import type { Match, RuleDoc } from "./engine.js";
import {
  falsePositiveFeedback,
  GENERATE_SCHEMA,
  GENERATE_SYSTEM,
  generatePrompt,
  isGenerateResponse,
  isReviewResponse,
  REVIEW_SCHEMA,
  REVIEW_SYSTEM,
  reviewPrompt,
  type GenerateResponse,
} from "./prompts.js";
import type { FixSample } from "./sample.js";
import type { Antibody, AntibodyMeta, Config, Store } from "./store.js";
import { coveredBy, matchContext, validate } from "./validate.js";

export type Outcome =
  | { status: "learned"; antibody: Antibody; latent: Match[]; reviewed: boolean; attempts: number }
  | { status: "skipped"; reason: string }
  | { status: "covered"; by: string }
  | { status: "failed"; reason: string; attempts: number }
  /** The model backend was unavailable; the fix was not really analyzed and should be retried later. */
  | { status: "interrupted"; reason: string };

export interface LearnContext {
  root: string;
  store: Store;
  llm: LLMProvider;
  config: Config;
  /** Serializes antibody writes when several fixes are learned in parallel. */
  mutex: Mutex;
  /** Optional progress callback, one line per step. */
  onStep?: (message: string) => void;
}

const RULE_KEYS = new Set(["pattern", "kind", "regex", "inside", "has", "follows", "precedes", "all", "any", "not", "matches", "nthChild", "range"]);

/** Turn the model's answer into an ast-grep rule document, or explain what is wrong with it. */
export function buildRule(res: GenerateResponse, sample: FixSample, attempts: number): { rule?: RuleDoc; error?: string } {
  let body: unknown;
  try {
    body = YAML.parse(res.rule_yaml);
  } catch (e) {
    return { error: `rule_yaml is not valid YAML: ${(e as Error).message}` };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "rule_yaml must be a YAML mapping with a top-level `rule:` key." };
  let doc = body as Record<string, unknown>;
  if (!("rule" in doc) && Object.keys(doc).some((k) => RULE_KEYS.has(k))) doc = { rule: doc };
  if (!doc.rule || typeof doc.rule !== "object") return { error: "rule_yaml must contain a top-level `rule:` mapping." };

  const meta: AntibodyMeta = {
    title: unescapeHtml(res.title || res.id),
    learnedAt: new Date().toISOString(),
    source: {
      kind: sample.kind,
      commit: sample.sha,
      subject: sample.subject,
      date: sample.date,
      files: sample.files.map((f) => f.path),
    },
    validation: { firesOnBuggy: true, silentOnFixed: true, headMatches: 0, attempts, reviewed: false },
  };
  const rule: RuleDoc = {
    id: slug(res.id || res.title || "antibody"),
    language: sample.language.id,
    severity: res.severity === "warning" ? "warning" : "error",
    message: unescapeHtml(res.message.trim()),
    note: unescapeHtml(res.note.trim()),
    rule: doc.rule,
    ...(doc.constraints ? { constraints: doc.constraints } : {}),
    ...(doc.utils ? { utils: doc.utils } : {}),
    ...(doc.transform ? { transform: doc.transform } : {}),
    metadata: { bugvax: meta },
  };
  return { rule };
}

/** Models sometimes HTML-escape code in prose ("=&gt;"); messages are shown in terminals, not HTML. */
function unescapeHtml(s: string): string {
  return s.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return out || "antibody";
}

/**
 * Learn one antibody from one bug fix: ask the model for a rule, validate it against the real
 * before/after code, feed failures back, and let a reviewer vet any matches in today's code.
 */
export async function learnFromSample(sample: FixSample, ctx: LearnContext): Promise<Outcome> {
  if (!sample.files.length) return { status: "skipped", reason: "no source changes to learn from" };
  const step = ctx.onStep ?? (() => {});
  const globs = ctx.config.exclude.map((g) => (g.startsWith("!") ? g : `!${g}`));

  const existing = await ctx.store.antibodies();
  const already = await coveredBy(existing.map((a) => a.doc), sample);
  if (already) return { status: "covered", by: already };

  const messages: ChatMessage[] = [{ role: "user", content: generatePrompt(sample) }];
  let lastProblem = "no valid rule produced";

  for (let attempt = 1; attempt <= ctx.config.maxAttempts; attempt++) {
    step(`attempt ${attempt}: asking ${ctx.llm.name} for a rule`);
    let res;
    try {
      res = await ctx.llm.completeJSON({ system: GENERATE_SYSTEM, messages, schema: GENERATE_SCHEMA as unknown as Record<string, unknown> });
    } catch (e) {
      // Refusals and truncated answers are about this fix; backend outages propagate to the caller.
      if (e instanceof LLMError && e.kind === "model") return { status: "failed", reason: e.message, attempts: attempt };
      throw e;
    }
    if (!isGenerateResponse(res.json)) {
      lastProblem = "model returned malformed JSON";
      messages.push({ role: "assistant", content: res.raw }, { role: "user", content: "That JSON did not match the required schema. Return the complete JSON object." });
      continue;
    }
    const answer = res.json;
    messages.push({ role: "assistant", content: res.raw });
    if (!answer.generalizable) return { status: "skipped", reason: answer.reason || "not a reusable bug pattern" };

    const built = buildRule(answer, sample, attempt);
    if (!built.rule) {
      lastProblem = built.error!;
      messages.push({ role: "user", content: `${built.error}\nReturn a corrected JSON object.` });
      continue;
    }
    const rule = built.rule;

    step(`attempt ${attempt}: validating ${rule.id}`);
    const v = await validate(rule, sample, ctx.root, { maxHeadMatches: ctx.config.maxHeadMatches, globs });
    if (!v.ok) {
      lastProblem = summarize(v.feedback ?? "validation failed");
      messages.push({ role: "user", content: `${v.feedback}\n\nReturn a corrected JSON object.` });
      continue;
    }

    let latent = v.headMatches;
    let reviewed = false;
    if (latent.length && ctx.config.review) {
      step(`attempt ${attempt}: reviewing ${latent.length} match(es) in current code`);
      const review = await reviewMatches(ctx, sample, rule, answer.rule_yaml, latent);
      if (review) {
        reviewed = true;
        if (review.falsePositives.length) {
          lastProblem = `rule also flagged ${review.falsePositives.length} correct location(s)`;
          messages.push({ role: "user", content: `${falsePositiveFeedback(review.falsePositives)}\n\nReturn a corrected JSON object.` });
          continue;
        }
        latent = review.realBugs;
      }
    }

    const meta = (rule.metadata as { bugvax: AntibodyMeta }).bugvax;
    meta.validation.headMatches = v.headMatches.length;
    meta.validation.reviewed = reviewed;
    return ctx.mutex.lock(async () => {
      // Another worker may have learned the same bug class in the meantime.
      const now = await ctx.store.antibodies();
      const dup = await coveredBy(now.map((a) => a.doc), sample);
      if (dup) return { status: "covered", by: dup } as Outcome;
      const antibody = await ctx.store.save(rule);
      return { status: "learned", antibody, latent, reviewed, attempts: attempt } as Outcome;
    });
  }
  return { status: "failed", reason: lastProblem, attempts: ctx.config.maxAttempts };
}

async function reviewMatches(
  ctx: LearnContext,
  sample: FixSample,
  rule: RuleDoc,
  ruleYaml: string,
  matches: Match[],
): Promise<{ realBugs: Match[]; falsePositives: { match: Match; context: string; reason: string }[] } | null> {
  const locations = await Promise.all(matches.map(async (match) => ({ match, context: await matchContext(ctx.root, match, 6) })));
  try {
    const res = await ctx.llm.completeJSON({
      system: REVIEW_SYSTEM,
      messages: [{ role: "user", content: reviewPrompt(sample, { id: rule.id, message: rule.message ?? "", note: rule.note ?? "", ruleYaml }, locations) }],
      schema: REVIEW_SCHEMA as unknown as Record<string, unknown>,
    });
    if (!isReviewResponse(res.json)) return null;
    const verdicts = new Map(res.json.verdicts.map((v) => [v.index, v]));
    const realBugs: Match[] = [];
    const falsePositives: { match: Match; context: string; reason: string }[] = [];
    locations.forEach((l, i) => {
      const v = verdicts.get(i + 1);
      if (v && !v.real_bug) falsePositives.push({ ...l, reason: v.reason });
      else realBugs.push(l.match);
    });
    return { realBugs, falsePositives };
  } catch (e) {
    // An unreviewed rule is still a validated rule, unless the backend is gone for good.
    if (e instanceof LLMError && e.kind !== "fatal") return null;
    throw e;
  }
}

function summarize(feedback: string): string {
  const first = feedback.split("\n").find((l) => l.trim()) ?? feedback;
  return first.replace(/^Validation failed:\s*/i, "").replace(/^ast-grep rejected the rule:?/i, "invalid rule").slice(0, 160);
}
