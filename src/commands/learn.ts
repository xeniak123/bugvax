import { commitInfo, hasParent, listCommits, repoRoot, withStats } from "../core/git.js";
import { learnFromSample, type Outcome } from "../core/learner.js";
import { DEFAULT_MINE, findCandidates, likelyFixes, toCandidate, type Candidate } from "../core/mine.js";
import { sampleFromCandidate, sampleFromWorkingTree, type FixSample } from "../core/sample.js";
import { Store, type Config } from "../core/store.js";
import { createProvider, LLMError, type Effort, type LLMProvider } from "../llm/index.js";
import { codeLine, firstSentence, header, loc, pc, plural, Progress, termWidth } from "../ui.js";
import type { Match } from "../core/engine.js";
import { mapLimit, Mutex } from "../util/proc.js";

export interface LearnOptions {
  maxCommits: string;
  limit: string;
  since?: string;
  commit?: string[];
  working?: boolean;
  message?: string;
  provider?: Config["provider"];
  model?: string;
  effort?: Effort;
  concurrency: string;
  dryRun?: boolean;
  retry?: boolean;
  review?: boolean;
  maxLines: string;
}

export async function learnCommand(opts: LearnOptions): Promise<number> {
  const root = await repoRoot(process.cwd());
  const store = new Store(root);
  if (!opts.dryRun && (await store.init())) console.log(pc.dim(`Created .bugvax/ in ${root}`));
  const config = await store.config();
  if (opts.provider) config.provider = opts.provider;
  if (opts.model) config.model = opts.model;
  if (opts.effort) config.effort = opts.effort;
  if (opts.review === false) config.review = false;
  const state = await store.state();

  header("learn", root);

  // 1. Pick the fixes to learn from.
  type Job = { key: string; label: string; sample: () => Promise<FixSample | null> };
  const jobs: Job[] = [];
  if (opts.working) {
    const message = opts.message ?? "uncommitted bug fix";
    jobs.push({ key: "working tree", label: `working tree  ${message}`, sample: () => sampleFromWorkingTree(root, message) });
  } else if (opts.commit?.length) {
    for (const rev of opts.commit) {
      const c = await commitInfo(root, rev);
      if (!(await hasParent(root, c.sha))) {
        console.log(pc.yellow(`  ${c.short} is a root commit, nothing to compare against. Skipping.`));
        continue;
      }
      const cand = toCandidate(c, DEFAULT_MINE, true);
      if (!cand) {
        console.log(pc.yellow(`  ${c.short} changes no supported source files. Skipping.`));
        continue;
      }
      jobs.push(jobFor(root, cand));
    }
  } else {
    const heads = await listCommits(root, { maxCount: Number(opts.maxCommits), since: opts.since });
    const likely = likelyFixes(heads);
    const fresh = likely.filter((h) => {
      const s = state.commits[h.sha];
      return !s || (opts.retry && s.status === "failed");
    });
    // Line stats need file contents, so fetch them batch by batch for the most promising commits only.
    const limit = Number(opts.limit);
    const mineOpts = { ...DEFAULT_MINE, maxLines: Number(opts.maxLines) };
    const batch = Math.max(limit * 2, 20);
    const ranked: Candidate[] = [];
    for (let i = 0; i < fresh.length && ranked.length < limit * 2; i += batch) {
      const enriched = await mapLimit(fresh.slice(i, i + batch), 8, (h) => withStats(root, h));
      ranked.push(...findCandidates(enriched, mineOpts));
    }
    ranked.sort((a, b) => b.score - a.score || b.commit.date.localeCompare(a.commit.date));
    const picked: Candidate[] = [];
    for (const c of ranked) {
      if (picked.length >= limit) break;
      if (await hasParent(root, c.commit.sha)) picked.push(c);
    }
    console.log(
      `  ${plural(heads.length, "commit")} scanned · ${plural(likely.length, "likely bug fix", "likely bug fixes")} · ` +
        `${likely.length - fresh.length} already analyzed · ${pc.bold(`analyzing ${picked.length}`)}`,
    );
    if (opts.dryRun) {
      for (const c of picked) {
        console.log(`  ${pc.yellow(c.commit.short)}  ${c.commit.subject}  ${pc.dim(`${c.language.id}, ${c.changedLines} lines, score ${c.score}`)}`);
      }
      return 0;
    }
    jobs.push(...picked.map((c) => jobFor(root, c)));
  }
  if (!jobs.length) {
    console.log(pc.dim("\n  Nothing new to learn from. Fix some bugs first 😉"));
    return 0;
  }

  // 2. Learn.
  let base: LLMProvider;
  try {
    base = createProvider({ provider: config.provider, model: config.model, effort: config.effort });
  } catch (e) {
    console.error(pc.red(`\n  ${(e as Error).message}`));
    return 1;
  }
  let calls = 0;
  let cost = 0;
  const llm: LLMProvider = {
    name: base.name,
    model: base.model,
    async completeJSON(req) {
      const res = await base.completeJSON(req);
      calls++;
      cost += res.costUsd ?? 0;
      return res;
    },
  };
  console.log(pc.dim(`  model: ${llm.name}${llm.model !== "default" ? ` (${llm.model})` : ""} · up to ${config.maxAttempts} attempts per fix\n`));

  const mutex = new Mutex();
  const width = String(jobs.length).length;
  const outcomes: Outcome[] = [];
  const latentAll: { match: Match; antibody: string }[] = [];
  const progress = new Progress();
  let done = 0;
  /** Set when the backend is gone for good (usage limit, auth): remaining fixes are left for next time. */
  let stopped: string | null = null;
  progress.start();

  await mapLimit(jobs, Number(opts.concurrency), async (job) => {
    if (stopped) {
      outcomes.push({ status: "interrupted", reason: stopped });
      return;
    }
    let outcome: Outcome;
    let sample: FixSample | null = null;
    progress.set(job.key, "reading");
    try {
      sample = await job.sample();
      outcome = sample
        ? await learnFromSample(sample, { root, store, llm, config, mutex, onStep: (s) => progress.set(job.key, s) })
        : { status: "skipped", reason: "no changed source files" };
    } catch (e) {
      const message = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200);
      if (e instanceof LLMError && e.kind !== "model") {
        // Not this fix's fault: don't record it, so the next run picks it up again.
        outcome = { status: "interrupted", reason: message };
        if (e.kind === "fatal") stopped ??= message;
      } else {
        // One broken fix (odd history, unexpected error) must not abort the whole run.
        outcome = { status: "failed", reason: message, attempts: 0 };
      }
    }
    progress.delete(job.key);
    outcomes.push(outcome);
    done++;
    await mutex.lock(async () => {
      if (sample?.kind === "commit" && sample.sha && outcome.status !== "interrupted") {
        const s = await store.state();
        s.commits[sample.sha] = {
          status: outcome.status,
          at: new Date().toISOString(),
          ...(outcome.status === "learned" ? { antibody: outcome.antibody.doc.id } : {}),
          ...(outcome.status === "covered" ? { antibody: outcome.by } : {}),
          ...(outcome.status === "skipped" || outcome.status === "failed" ? { reason: outcome.reason } : {}),
        };
        await store.saveState(s);
      }
    });
    const lines = [`  ${pc.dim(`[${String(done).padStart(width)}/${jobs.length}]`)} ${job.label}`];
    const pad = " ".repeat(width * 2 + 5);
    const room = Math.max(40, termWidth() - pad.length - 1);
    switch (outcome.status) {
      case "learned": {
        const tries = outcome.attempts > 1 ? pc.dim(` (attempt ${outcome.attempts})`) : "";
        const autofix = outcome.antibody.doc.fix ? pc.green("  🔧 proven auto-fix") : "";
        lines.push(`${pad}${pc.green("💉 antibody")} ${pc.bold(outcome.antibody.doc.id)}${tries}${autofix}`);
        lines.push(`${pad}${pc.dim(firstSentence(outcome.antibody.doc.message ?? "", room))}`);
        if (outcome.latent.length) {
          const label = outcome.reviewed ? "same bug still present in" : "possible copies in";
          lines.push(`${pad}${pc.yellow(`⚠ ${label} ${plural(outcome.latent.length, "place")}:`)}`);
          for (const m of outcome.latent) {
            lines.push(`${pad}  ${loc(m)}  ${codeLine(m.lines, Math.max(20, room - `${m.file}:${m.line}`.length - 4))}`);
            latentAll.push({ match: m, antibody: outcome.antibody.doc.id });
          }
        }
        break;
      }
      case "covered":
        lines.push(`${pad}${pc.green("✓ already covered by")} ${outcome.by}`);
        break;
      case "skipped":
        lines.push(`${pad}${pc.dim(`· skipped: ${firstSentence(outcome.reason, room - 11)}`)}`);
        break;
      case "failed":
        lines.push(`${pad}${pc.red(`✗ no antibody: ${firstSentence(outcome.reason, room - 15)}`)}`);
        break;
      case "interrupted":
        lines.push(`${pad}${pc.yellow(`⏸ not analyzed: ${firstSentence(outcome.reason, room - 17)}`)}`);
        break;
    }
    progress.log(lines.join("\n"));
  });
  progress.stop();

  // 3. Summary.
  const count = (s: Outcome["status"]) => outcomes.filter((o) => o.status === s).length;
  console.log(
    `\n  ${pc.bold(plural(count("learned"), "new antibody", "new antibodies"))}` +
      ` · ${pc.yellow(plural(latentAll.length, "latent bug"))}` +
      ` · ${count("covered")} already covered · ${count("skipped")} skipped · ${count("failed")} failed`,
  );
  console.log(pc.dim(`  ${plural(calls, "model call")}${cost > 0 ? ` · ≈ $${cost.toFixed(2)} of model usage` : ""}`));
  if (count("interrupted")) {
    const why = stopped ? `Stopped early: ${stopped}` : "The model backend was unavailable for some fixes.";
    console.log(pc.yellow(`\n  ⏸ ${why}`));
    console.log(pc.yellow(`    ${plural(count("interrupted"), "fix was", "fixes were")} not analyzed; run ${pc.bold("bugvax learn")} again later to continue.`));
  }
  if (count("learned")) {
    console.log(pc.dim(`  Antibodies are in .bugvax/antibodies/. Review and commit them.`));
    console.log(pc.dim(`  Next: ${pc.reset("bugvax scan")} to see every match · ${pc.reset("bugvax init --claude-code")} to guard your AI agent`));
  }
  return 0;
}

function jobFor(root: string, c: Candidate) {
  return {
    key: c.commit.short,
    label: `${pc.yellow(c.commit.short)}  ${c.commit.subject}`,
    sample: () => sampleFromCandidate(root, c),
  };
}
