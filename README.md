# 🧬 bugvax

**Vaccinate your codebase.** bugvax turns every bug you have ever fixed into an *antibody*: a validated rule that blocks that whole class of bug from coming back, whether a human or an AI agent writes it.

```bash
npx bugvax learn
```

```
🧬 bugvax learn
  8 commits scanned · 7 likely bug fixes · analyzing 7

  [1/7] ca73865  fix: await db commit when refunding orders
        💉 antibody unawaited-db-commit
        db.commit() is not awaited: the commit may reject or not be flushed before the function returns
        ⚠ same bug still present in 1 place:
          src/invoices.ts:6  db.commit();
  [2/7] cf59d6d  fix: shipping quote hung forever when rates API was down
        💉 antibody requests-call-without-timeout
        This requests.* HTTP call has no timeout= argument and can block forever if the remote host stalls.
        ⚠ same bug still present in 1 place:
          app/payments.py:7  resp = requests.post(PAYMENTS_URL, json={"amount": amount_cents, …
  [3/7] b7302a7  fix: apply discount before tax
        · skipped: This is a business-logic/arithmetic ordering change …
  …
```

You fixed each of those bugs once. bugvax makes sure you never fix them again, and it finds the copies of them that are still in your code today.

---

## Why

- **Agents and people repeat the same mistakes.** The bug you fixed in March comes back in June in another file.
- **`CLAUDE.md` / `AGENTS.md` rules are suggestions.** Agents forget them, and nobody checks that they were followed.
- **AI code review is probabilistic.** It costs tokens on every PR and remembers nothing.
- **Linters ship generic rules.** They know nothing about the bugs *your* project already paid for.

bugvax learns from your git history and compiles each fix into a deterministic [ast-grep](https://ast-grep.github.io) rule. The rule runs in milliseconds, with no AI involved, on every agent edit, every commit and every PR.

## How it works

1. **Mine.** bugvax finds bug-fix commits in your history: `fix:` messages, hotfixes, `fixes #123`, regression tests. It skips the noise: typos, lint, formatting, dependency bumps, test-only changes and huge rewrites.
2. **Generalize.** An LLM turns each fix into an ast-grep rule for the *class* of bug, not just the one line that changed.
3. **Validate.** This step is what makes the rules trustworthy. A rule is kept only if:
   - ✅ it **matches the buggy code**, on the lines the fix changed;
   - ✅ it **does not match the fixed code**;
   - ✅ it does not light up half the codebase;
   - ✅ a second, independent model call confirms that the rule's matches in today's code are real bugs.

   Every failure goes back to the model as concrete feedback ("your rule still matches the fixed code at line 6…"), for up to 3 attempts. Fixes that are not reusable patterns, such as business logic or changed constants, are skipped instead of forced into a rule.
4. **Enforce.** Antibodies are plain ast-grep YAML files in `.bugvax/antibodies/`. You review them like code and commit them. Checks are deterministic and fast, and they run in your agent's hooks, in pre-commit and in CI. **No LLM runs at check time.**

bugvax also avoids duplicates. If an existing antibody already catches a new fix, the fix is marked *covered* and no model call is made.

## Quick start

```bash
npx bugvax learn                             # learn antibodies from your bug-fix history
npx bugvax scan                              # find every latent copy of an old bug
npx bugvax init --claude-code --git-hook     # guard every agent edit and every commit
```

Just fixed a bug and haven't committed yet? Learn from it right away:

```bash
npx bugvax learn --working -m "crash when the cart is empty"
```

No bug history at hand? Try the demo shop. Its history holds 7 bug fixes across TypeScript, React and Python, and 6 of those bugs are still hiding somewhere else in its code:

```bash
npx bugvax demo && cd demo-shop && npx bugvax learn
```

In our run bugvax learned 6 antibodies and found all 6 hidden bugs, with no false positives. It also skipped the business-logic fix ("apply discount before tax"), which is not a reusable pattern.

## Model backends

bugvax needs a model only while **learning**. `scan` and `check` never call a model.

| Backend | When it is used | Notes |
|---|---|---|
| **Claude Code** | default when no API key is set | Uses your Claude subscription through `claude -p`, in a locked-down mode: no tools, no MCP servers, no hooks, no CLAUDE.md. |
| **Anthropic API** | when `ANTHROPIC_API_KEY` is set, or with `--provider anthropic` | Defaults to `claude-opus-5`. Change it with `--model`. |

The model sees only the diff of each fix it analyzes, plus snippets of the code where a new rule matches (for the review step).

A fix usually takes 1–4 model calls. With the Claude Code backend those calls count toward your plan's usage limits, just like your normal sessions, so `--limit` (default 15 fixes per run) keeps each run small. If the backend hits a usage limit, bugvax stops right away. The fixes it could not analyze are left for the next `bugvax learn`, not marked as failed.

## Guard your AI agent

`bugvax init --claude-code` adds a `PostToolUse` hook to `.claude/settings.json`. After every edit, bugvax checks the lines the agent changed. If the agent re-introduces a known bug, the edit is reported back to it immediately:

```
bugvax: this edit re-introduces 1 bug that this repository already fixed before.

src/refunds.ts:6  [unawaited-db-commit] db.commit() is not awaited: the commit may reject …
  code: db.commit();
  fix: commit() returns a promise; without await, failures surface after the response …
  history: fixed before in ca73865 "fix: await db commit when refunding orders"

Please fix these before continuing.
```

The agent fixes the bug on its own, before it tells you it is "done".

## CI

```yaml
# .github/workflows/bugvax.yml
name: bugvax
on: pull_request
jobs:
  bugvax:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v5
        with: { node-version: 22 }
      - run: npx -y bugvax check --base origin/${{ github.base_ref }}
```

`check` reports only findings on changed lines. An old latent bug elsewhere in a file never blocks an unrelated PR. Use `bugvax scan` to see all of them.

## Commands

| Command | What it does |
|---|---|
| `bugvax learn` | Learn antibodies from bug fixes in git history (incremental: only new commits). Useful flags: `--limit`, `--since`, `--commit <sha>`, `--working`, `--dry-run`, `--retry`, `--model`, `--provider` |
| `bugvax scan [paths]` | Find every match of every antibody: latent copies of old bugs |
| `bugvax check` | Check uncommitted changes. `--staged` for pre-commit, `--base <ref>` for CI, `--hook claude-code` for agents |
| `bugvax list` | List antibodies and where each one came from |
| `bugvax init` | Create `.bugvax/`. `--claude-code` and `--git-hook` install the hooks |
| `bugvax demo [dir]` | Create a demo repository with real-looking bug fixes to try bugvax on |

## What gets stored

```
.bugvax/
  antibodies/unawaited-db-commit.yml   # plain ast-grep rules: review, edit, delete them freely
  config.json                          # provider, model, effort, attempts, exclusions
  state.json                           # which commits were already analyzed
```

Commit the whole folder. Your teammates and your CI then get the same immunity without spending a single model call.

`config.json`:

```json
{
  "provider": "auto",
  "effort": "high",
  "maxAttempts": 3,
  "maxHeadMatches": 10,
  "review": true,
  "exclude": ["**/legacy/**"]
}
```

## Languages

JavaScript and TypeScript (one antibody covers `.js`, `.jsx`, `.ts` and `.tsx`), Python, Go, Rust, Java, Kotlin, Ruby, PHP, C#, Swift, C, C++, Scala, Lua and Elixir: everything ast-grep parses.

## FAQ

**Is this a linter?** It is a linter *generator*. The rules come from your own history, so they catch the mistakes your team and your agents actually make.

**What if an antibody is wrong?** It is a YAML file. Edit it or delete it. Every antibody records the commit it came from, so you can always check why it exists.

**How much does learning cost?** Usually 1–4 model calls per fix, and only once per commit. On later runs bugvax looks only at new history.

**How is this different from AI code review?** Review bots re-read your code with a model on every PR and forget everything afterwards. bugvax spends model calls once, at learning time, and produces rules that are deterministic, free to run, and reviewable in git.

**Prior art?** Meta's [Getafix](https://engineering.fb.com/2018/11/06/developer-tools/getafix-how-facebook-tools-learn-to-fix-bugs-automatically/) learned fix patterns from Facebook's own history but was never released. bugvax brings the idea to every repository and to the age of coding agents.

## Roadmap

- 💉 **Vaccine registry**: shared antibody packs for popular libraries (Next.js, Supabase, Stripe, React, Django…), learned from fixes across open source. `bugvax vaccinate supabase`
- MCP server, so agents can ask "what has gone wrong here before?" *before* they write code
- Hooks for Cursor, Codex and Gemini CLI
- GitHub App that comments on PRs with the history of each re-introduced bug
- Auto-fix suggestions through ast-grep `fix:` templates

## Development

```bash
npm install
npm test           # unit + integration tests (real git repos, real ast-grep)
npm run dev -- learn --dry-run
npm run build
```

## License

MIT
