---
name: bugvax
description: Use in any repository that has a .bugvax/ directory, before changing code that looks like code which broke before, right after fixing a bug, before telling the user a coding task is done, and whenever the user mentions bugvax, antibodies, regressions or "the same bug again". bugvax turns the repository's own bug-fix history into deterministic ast-grep rules and tells you when your code re-introduces a bug that was already fixed.
---

# bugvax: don't re-introduce bugs this repository already fixed

bugvax learned "antibodies" from this repository's git history: each one is an ast-grep rule for a bug class that was fixed here before, validated against the real buggy and fixed code. Checks are deterministic and take milliseconds. Use them.

## While you work

1. **Before editing unfamiliar code**, ask what went wrong there before:
   - MCP tool `bug_history` with the file path (or a query such as `timeout`), or
   - `npx bugvax list` in a shell.
   Treat every antibody that matches the language as a constraint on the code you are about to write. Existing code in the repository may still contain these bugs (latent copies), so **do not copy a pattern just because it exists nearby**.
2. **Before writing a new file or a larger block**, you can check the code first with the MCP tool `check_code` (`path` + `content`).
3. **When bugvax reports a re-introduced bug** (from a hook, `check_code` or `bugvax check`), fix it before doing anything else. Apply the proven fix it shows when there is one. Never delete, weaken or bypass an antibody to make a finding go away. If you are convinced a finding is a false positive, say so to the user, explain why, and leave the antibody alone.
4. **Before you say the task is done**, run `npx bugvax check` (checks your uncommitted changes). Fix what it reports.

## After fixing a bug

Right after you fix a real bug (and before it is committed), turn the fix into an antibody so the whole bug class is blocked from now on:

- MCP tool `learn_from_fix` with a one-sentence description of the bug, or
- `npx bugvax learn --working -m "<what was wrong>"`.

Report what it learned. If it says the same bug still exists elsewhere, tell the user and offer `npx bugvax fix --dry-run`.

## Setting bugvax up for a user

- `npx bugvax learn` learns antibodies from the git history (it uses the user's Claude Code subscription or `ANTHROPIC_API_KEY`; it stops cleanly on usage limits).
- `npx bugvax scan` lists latent copies of old bugs; `npx bugvax fix --dry-run` previews proven fixes, `npx bugvax fix` applies them.
- `npx bugvax vaccinate starter` adds validated antibodies for classic bug classes when there is no history yet.
- `npx bugvax init --claude-code --git-hook` installs the hooks for a project without the plugin.

Antibodies live in `.bugvax/antibodies/*.yml` and should be committed.
