# Agent eval: does Claude Code write better code with bugvax?

`scripts/eval-agents.mjs` gives headless Claude Code (`claude -p`, Sonnet) small coding tasks of the kind agents get every day: "add X, like the existing Y". The existing Y still contains a copy of a bug the repository already fixed somewhere else, which is exactly how agents re-introduce old bugs.

- **baseline**: plain Claude Code, no bugvax in the repository.
- **bugvax**: the same setup the Claude Code plugin installs: the session briefing, a check after every edit, a check before finishing, the MCP server and the skill.

Scoring is deterministic. The repository's learned antibodies run over the code the agent wrote, from a copy outside the repository so the agent cannot change its own score. A run counts as completed when the requested function exists. It is flagged as tampered if the agent touched `.bugvax/`.

## Results (Sonnet, 2 runs per task and condition)

| suite | what the agent has to know | runs with a re-introduced bug, baseline | with bugvax | tasks completed |
|---|---|---|---|---|
| [ledger](results-ledger-sonnet-v2.md) | this project's own conventions, learned from its history: a money helper, an outbox instead of an in-process bus, a tenant filter, a UTC timestamp parser, a nullable lookup | **5 / 6** (11 bugs) | **0 / 6** | 6/6 → 6/6 |
| [shop](results-shop-sonnet-baseline.md) ([bugvax](results-shop-sonnet-bugvax.md)) | classic bug classes: an un-awaited commit, a missing return in Express middleware, a mutable default, no HTTP timeout, a missing effect dependency array, a numeric sort | **2 / 12** (2 bugs) | **0 / 12** | 12/12 → 12/12 |

No agent edited or deleted an antibody to get past a check.

What this shows: a strong model already avoids most *generic* bugs on its own (shop: 2 of 12 runs failed without bugvax). It cannot know a project's *own* rules ("use `toCents()`", "enqueue to the outbox", "always pass `{ tenantId }`"). Those exist only in the history, and it copied the old buggy code 5 times out of 6. With bugvax the same model got every run right.

The cost: with bugvax, runs took about 10 seconds longer on the ledger suite (35 s vs 25 s on average) and about the same on the shop suite (21 s vs 19 s). Model cost was about the same.

## Caveats

- Small samples: 2 runs per task and condition, one model.
- The repositories were built for the eval (`bugvax demo` and `scripts/eval-repo.mjs`), and the tasks deliberately point the agent at code that still contains a fixed bug. The eval measures re-introduced *known* bugs, not overall code quality.
- The same antibodies are enforced during the bugvax runs and used for scoring. The eval therefore answers "does the agent act on the feedback and still finish the task?", not "are the antibodies right?". Antibody quality is checked separately: each rule must fire on the real buggy code, stay silent on the fix, and pass a review of its matches (see the README).
- The shop baseline was run earlier than its bugvax runs, with the same tasks and harness.

## Reproduce

```bash
npm run build
node scripts/eval-agents.mjs --suite ledger --trials 2 --model sonnet
node scripts/eval-agents.mjs --suite shop --trials 2 --model sonnet
```

Antibodies are learned from recorded model answers (`scripts/.eval-cache`, `scripts/.demo-cache`), so building the repositories costs nothing. The agent runs use your Claude plan: about 12 to 24 short Sonnet sessions per suite.
