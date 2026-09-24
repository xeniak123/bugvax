# Changelog

## 0.1.0

First release.

- `bugvax learn` mines bug-fix commits from git history and turns each fix into an ast-grep rule (an antibody). A rule is kept only if it matches the buggy code, stays silent on the fixed code, is not too broad, and an independent review confirms its matches in today's code. Works with a Claude Code subscription (`claude -p`) or an Anthropic API key, stops cleanly on usage limits, and only looks at new history on later runs.
- `bugvax fix` applies fix templates that were proven to reproduce the real historical fix.
- `bugvax scan` and `bugvax check` (uncommitted changes, `--staged`, `--base <ref>`) run deterministically, with no model.
- Agent integrations: a Claude Code plugin (session briefing, a check after every edit and before finishing, MCP server, skill), and hooks for Cursor, Gemini CLI and Codex via `bugvax init`.
- MCP server with `check_code`, `bug_history`, `scan`, `fix` and `learn_from_fix`.
- `bugvax vaccinate starter`: validated antibodies for classic bug classes.
- GitHub Action (`uses: xeniak123/bugvax@v1`) with annotations on changed lines, and a git pre-commit hook.
