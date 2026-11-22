# Pitbox

A pit wall for Claude Code in the Claude desktop app. It shows how the session is going while you work: what model and how much of your limits, which skills fired, the state of the repo, and how far along Claude's plan is.

It has two parts.

## The band above the prompt

Two lines, colored with your theme's own colors:

| Line | Shows |
| --- | --- |
| 1 | Model · context, 5-hour and 7-day usage as percentages · the skills, hub specialists (`hub › spoke`) and subagents this turn used |
| 2 | Git branch, ahead/behind, changed files · the latest GitHub Actions run on the branch · the latest plugin eval pass rate · ↻ refresh |

- CI comes from `gh run list`, so it needs the GitHub CLI signed in, and is asked at most every 2 minutes.
- Evals come from the newest `.json` in `evals/results/` (a `claude plugin eval --json` report). A project without that folder shows no evals.
- The rest refreshes every 30 seconds and when a turn ends.

## The sidebar

Opens in the right-hand panel as a **Pitbox** tab (show the panel with **Ctrl+.**, or run `/pitbox`).

- **Phases:** Cost, Tokens and Time tiles, a progress pill, then Running, Waiting and Finished phases, each with its branch, steps, pass criteria and a bar.
- **Recent tool calls**, with ✓ done, ✗ failed and … running.

Where the phases come from, first match wins:

1. **A plan Claude writes**, in a reply or a plan file under `plans/`: two or more headings such as `Phase 1: Fix the client hooks (`refactor/client-hooks`) — small, low risk`, with bullets under each, and a `เกณฑ์ผ่าน:` or `Exit criteria:` bullet. `ระยะ`, `เฟส` and `Stage` work too.
2. **Claude's task list** (TodoWrite or the app's task list), with when each step started and ended.
3. **`.claude/phases.json`** in the project: `[{ "name": "...", "status": "done" | "doing" | "todo", "note": "..." }]`.

A written phase turns **running** when the task list names it (`Phase 2 …`) or when its branch is checked out, and **done** when the task list says so.

## Install

```
/plugin install pitbox --marketplace tp-job/pitbox
```

Or load it from a folder: add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`, then restart Claude.

## Limits

- The band and sidebar draw in the desktop and mobile apps; the terminal shows neither.
- The cost tile is the whole session's estimate, as `/cost` gives it, not the bill.
- A running phase's bar is drawn half full: Pitbox does not know how far along a phase is.
- A phase is not marked done when its branch merges; the task list has to say so.

## License

MIT
