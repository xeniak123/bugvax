---
name: bugvax
description: Use in any repository that has a .bugvax/ directory, before writing code modelled on existing code, right after fixing a bug, before telling the user a coding task is done, and whenever the user mentions bugvax, antibodies, regressions or "the same bug again". bugvax turns the repository's own bug-fix history into deterministic ast-grep rules and tells you when your code re-introduces a bug that was already fixed.
---

# bugvax: don't re-introduce bugs this repository already fixed

bugvax learned "antibodies" from this repository's git history: each one is an ast-grep rule for a bug class that was fixed here before, validated against the real buggy and fixed code. Many of them encode this project's own conventions (which helper to use, which call is forbidden, which argument is required), so general best practice is not enough to get them right. Checks are deterministic and take milliseconds. Use them.

## While you work

1. **Read the bugvax briefing** if one was added at session start. It lists the bug classes fixed here and the exact places where **known-bad copies still live**. Never use those places as examples, even when the task says "do it like X". Copy the corrected pattern from the fix instead.
2. **Before editing unfamiliar code**, ask what went wrong there before: the MCP tool `bug_history` with the file path (or a query such as `timeout`), or `npx bugvax list`. Treat every antibody for the language as a constraint on the code you are about to write. Existing code may still contain these bugs, so **do not copy a pattern just because it exists nearby**.
3. **Before writing a new file or a larger block**, check it first with the MCP tool `check_code` (`path` + `content`).
4. **When bugvax reports a re-introduced bug** (from a hook, `check_code` or `bugvax check`), fix it before doing anything else. Apply the proven fix it shows when there is one. Never delete, weaken or bypass an antibody to make a finding go away, and never edit `.bugvax/`. If you are convinced a finding is a false positive, say so to the user, explain why, and leave the antibody alone.
5. **Before you say the task is done**, make sure `npx bugvax check` (your uncommitted changes) is clean.

## After fixing a bug

When you fix a real bug, offer to turn the fix into an antibody so the whole bug class is blocked from now on. It takes 1–4 model calls on the user's Claude plan or API key, so do it when the user agrees or has asked for it:

- MCP tool `learn_from_fix` with a one-sentence description of the bug (while the fix is still uncommitted), or
- `npx bugvax learn --working -m "<what was wrong>"`.

Report what it learned. If it says the same bug still exists elsewhere, tell the user and offer `npx bugvax fix --dry-run`.

## Setting bugvax up for a user

- `npx bugvax learn` learns antibodies from the git history (it uses the user's Claude Code subscription or `ANTHROPIC_API_KEY`; it stops cleanly on usage limits).
- `npx bugvax scan` lists latent copies of old bugs; `npx bugvax fix --dry-run` previews proven fixes, `npx bugvax fix` applies them.
- `npx bugvax vaccinate starter` adds validated antibodies for classic bug classes when there is no history yet.
- `npx bugvax init --claude-code --git-hook` installs the hooks for a project without the plugin.

Antibodies live in `.bugvax/antibodies/*.yml` and should be committed.
