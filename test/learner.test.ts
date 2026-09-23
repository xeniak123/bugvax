import { afterEach, describe, expect, it } from "vitest";
import { commitInfo } from "../src/core/git.js";
import { learnFromSample } from "../src/core/learner.js";
import { toCandidate } from "../src/core/mine.js";
import { sampleFromCandidate } from "../src/core/sample.js";
import { DEFAULT_CONFIG, Store } from "../src/core/store.js";
import { LLMError, type CompleteJSONRequest, type CompleteJSONResult, type LLMProvider } from "../src/llm/types.js";
import { Mutex } from "../src/util/proc.js";
import { GOOD_RULE_YAML, unawaitedCommitRepo, type TestRepo } from "./helpers.js";

/** Replays scripted answers and records every request. */
class FakeProvider implements LLMProvider {
  readonly name = "fake";
  readonly model = "fake";
  requests: CompleteJSONRequest[] = [];
  constructor(private answers: unknown[]) {}
  async completeJSON(req: CompleteJSONRequest): Promise<CompleteJSONResult> {
    this.requests.push({ ...req, messages: [...req.messages] }); // snapshot: the learner keeps appending to its array
    const json = this.answers.shift();
    if (json === undefined) throw new Error("no more scripted answers");
    return { json, raw: JSON.stringify(json) };
  }
}

const answer = (rule_yaml: string, extra: object = {}) => ({
  generalizable: true,
  reason: "commit() returns a promise; not awaiting it swallows errors",
  id: "unawaited-db-commit",
  title: "Unawaited db.commit()",
  message: "db.commit() is not awaited, so failures are silently lost",
  note: "Await the commit (or return its promise) so errors propagate.",
  severity: "error",
  rule_yaml,
  ...extra,
});

describe("learnFromSample", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  async function setup() {
    const r = await unawaitedCommitRepo();
    repo = r.repo;
    const sample = await sampleFromCandidate(repo.dir, toCandidate(await commitInfo(repo.dir, r.fixSha))!);
    const store = new Store(repo.dir);
    await store.init();
    return { sample, store };
  }

  it("retries with validation feedback, reviews latent matches, and saves the antibody", async () => {
    const { sample, store } = await setup();
    const llm = new FakeProvider([
      answer("rule:\n  pattern: $DB.commit()\n"), // too loose: still matches the fix
      answer(GOOD_RULE_YAML),
      { verdicts: [{ index: 1, real_bug: true, reason: "voidInvoice has the same unawaited commit" }] },
    ]);
    const outcome = await learnFromSample(sample, { root: repo.dir, store, llm, config: { ...DEFAULT_CONFIG }, mutex: new Mutex() });

    expect(outcome.status).toBe("learned");
    if (outcome.status !== "learned") return;
    expect(outcome.attempts).toBe(2);
    expect(outcome.reviewed).toBe(true);
    expect(outcome.latent.map((m) => `${m.file}:${m.line}`)).toEqual(["src/invoices.ts:6"]);
    // The second generation request carried the validation failure back to the model.
    const retry = llm.requests[1].messages;
    expect(retry[retry.length - 1].content).toMatch(/still matches the FIXED code/);

    const saved = await store.antibodies();
    expect(saved.map((a) => a.doc.id)).toEqual(["unawaited-db-commit"]);
    expect(saved[0].doc.language).toBe("tsx");
    expect((saved[0].doc.metadata as any).bugvax.source.subject).toBe("fix: await db commit in refunds");

    // Learning the same fix again is recognized as already covered, without calling the model.
    const again = await learnFromSample(sample, { root: repo.dir, store, llm: new FakeProvider([]), config: { ...DEFAULT_CONFIG }, mutex: new Mutex() });
    expect(again).toEqual({ status: "covered", by: "unawaited-db-commit" });
  });

  it("refines the rule when the reviewer finds false positives", async () => {
    const { sample, store } = await setup();
    const llm = new FakeProvider([
      answer(GOOD_RULE_YAML),
      { verdicts: [{ index: 1, real_bug: false, reason: "pretend this one is fine" }] },
      answer(GOOD_RULE_YAML),
      { verdicts: [{ index: 1, real_bug: true, reason: "ok" }] },
    ]);
    const outcome = await learnFromSample(sample, { root: repo.dir, store, llm, config: { ...DEFAULT_CONFIG }, mutex: new Mutex() });
    expect(outcome.status).toBe("learned");
    const feedback = llm.requests[2].messages.at(-1)!.content;
    expect(feedback).toMatch(/false positives/);
    expect(feedback).toContain("src/invoices.ts:6");
  });

  it("skips fixes the model says are not generalizable", async () => {
    const { sample, store } = await setup();
    const llm = new FakeProvider([{ ...answer(""), generalizable: false, reason: "business logic change" }]);
    const outcome = await learnFromSample(sample, { root: repo.dir, store, llm, config: { ...DEFAULT_CONFIG }, mutex: new Mutex() });
    expect(outcome).toEqual({ status: "skipped", reason: "business logic change" });
    expect(await store.antibodies()).toHaveLength(0);
  });

  it("lets backend outages propagate instead of recording the fix as failed", async () => {
    const { sample, store } = await setup();
    const limited: LLMProvider = {
      name: "fake",
      model: "fake",
      completeJSON: async () => {
        throw new LLMError("You've hit your session limit · resets 6:50pm", "fatal");
      },
    };
    await expect(learnFromSample(sample, { root: repo.dir, store, llm: limited, config: { ...DEFAULT_CONFIG }, mutex: new Mutex() })).rejects.toMatchObject({ kind: "fatal" });

    const refusing: LLMProvider = { ...limited, completeJSON: async () => { throw new LLMError("The model declined to analyze this change.", "model"); } };
    const outcome = await learnFromSample(sample, { root: repo.dir, store, llm: refusing, config: { ...DEFAULT_CONFIG }, mutex: new Mutex() });
    expect(outcome).toMatchObject({ status: "failed", reason: "The model declined to analyze this change." });
  });

  it("gives up after maxAttempts", async () => {
    const { sample, store } = await setup();
    const bad = answer("rule:\n  pattern: $DB.rollback()\n");
    const llm = new FakeProvider([bad, bad]);
    const outcome = await learnFromSample(sample, { root: repo.dir, store, llm, config: { ...DEFAULT_CONFIG, maxAttempts: 2 }, mutex: new Mutex() });
    expect(outcome.status).toBe("failed");
    expect(await store.antibodies()).toHaveLength(0);
  });
});
