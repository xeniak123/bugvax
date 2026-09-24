# Changelog

## 0.2.0

- **Agents write better code with bugvax, measured.** In a headless Claude Code eval, runs that brought an already-fixed bug back went from 5/6 to 0/6 on a project's own conventions, and from 2/12 to 0/12 on classic bug classes, with every task still completed. See [eval/](eval/README.md).
- **Claude Code plugin** (`/plugin marketplace add xeniak123/bugvax`, then `/plugin install bugvax@bugvax`): a session briefing on the bug classes the repository fixed before and where known-bad copies still live (`bugvax context`), a check after every edit, a check of the whole session's changes before Claude may finish (`check --hook claude-code-stop`), the MCP server and a skill. `bugvax init --claude-code` installs the same hooks and skill per project.
- `bugvax fix` applies fix templates that were proven to reproduce the real historical fix. A template that does not change the code, produces code that no longer parses, or only matches whitespace-insensitively where indentation matters (Python) is not accepted as proven.
- MCP server with `check_code`, `bug_history`, `scan`, `fix` and `learn_from_fix`. It finds the repository from an absolute path, the client's MCP roots or `BUGVAX_ROOT`, resolves relative paths from the repository root, reports bad paths as errors, and `learn_from_fix` reports progress and can be cancelled.
- Hooks for Cursor (`afterFileEdit` + `stop`: only the agent's own files are checked), Gemini CLI and Codex via `bugvax init`.
- `bugvax vaccinate starter`: validated antibodies for classic bug classes.
- GitHub Action (`uses: xeniak123/bugvax@v1`) that runs the bugvax version matching the action, with annotations on changed lines, and a git pre-commit hook.
- Correctness: `exclude` is honoured everywhere (hooks, `check`, CI, MCP); deleting a guard line is caught; non-ASCII file names work; user git settings (`diff.external`, `diff.mnemonicPrefix`, …) no longer change results; a broken antibody file is named instead of silently disabling checks; findings are reported in a stable order, so reviews and replays are reproducible; usage limits, offline and setup errors stop `learn` without marking fixes as failed.
- Requires Node.js 22.12 or newer.

## 0.1.0

First npm release: `bugvax learn`, `scan`, `check`, `list`, `demo`, and the Claude Code `PostToolUse` hook.
