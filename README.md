# Pitbox

A pit wall for Claude Code in the Claude desktop app. It shows how the session is going while you work: what model and how much of your limits, which skills fired, the state of the repo, and how far along Claude's plan is.

It has two parts.

## The band above the prompt

In the desktop and mobile apps: ring gauges for context and usage (with the time to each reset), then dotted progress rows with a status pill for evals (or the branch) and CI, and under them the plan as one bar (the phase list stays in the sidebar). The terminal gets the same as plain colored text.

| Line | Shows |
| --- | --- |
| 1 | Model · context, 5-hour and 7-day usage as percentages · the skills, hub specialists (`hub › spoke`) and subagents this turn used |
| 2 | Git branch, ahead/behind, changed files · the latest GitHub Actions run on the branch · the latest plugin eval pass rate |
| 3 | The skills, hub specialists and subagents this turn used, then the macro buttons on the right, in three groups |

- CI comes from `gh run list`, so it needs the GitHub CLI signed in, and is asked at most every 2 minutes.
- Evals come from the newest `.json` in `evals/results/` (a `claude plugin eval --json` report). A project without that folder shows no evals.
- The rest refreshes every 30 seconds and when a turn ends.

### Macro buttons

Each button sends a message as if you had typed it, shows a line under the buttons while the pointer is over it (what the button is, what a press does, its key), and has a one-letter shortcut that works while the band holds the keyboard (click the band, or ctrl+x then tab).

| Button | Key | Sends |
| --- | --- | --- |
| ↻ | `r` | refreshes the band |
| ⊙ | `c` | Commit the current changes. |
| ⑂ | `p` | Open a pull request for this branch. |
| ⇡ | `u` | Push the current branch, naming what goes where and waiting for your yes |
| ✓ | `t` | Run the tests and report what fails. |
| ▶ | `n` | Continue with the next step of the plan. |
| ⌕ | `v` | Review my uncommitted changes for bugs. |

The list is `MACROS` in `hooks/band.tsx`: change a message or key there.

## The sidebar

Opens in the right-hand panel as a **Pitbox** tab (show the panel with **Ctrl+.**, or run `/pitbox`).

- **Phases**, drawn like the band: Cost, Tokens and Time tiles, the whole plan as one bar with the current phase in its pill, then Running, Waiting and Finished phases, each with its branch, steps, pass criteria and a bar.

⊙ and ⑂ in the band ask Claude to commit the changes or open a pull request, as if you had typed it; Claude still shows you what it does.


- **Branches** of the project the session is open in: the current branch first, then the default, then the rest by last commit (up to 12). Each shows its last commit's age and subject and chips for its state: `default`, `in sync`, `↑n to push`, `↓n to pull`, `local only`, `remote deleted`, `merged`, and its pull request (`PR #n open`, `draft`, `merged`, `closed`). Sync is against the last fetch (Pitbox never fetches); pull requests come from `gh`, at most every 2 minutes.

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

- The drawings are for the desktop and mobile apps. A terminal gets a text view: usage and plan bars, worded shortcut buttons, and the sidebar as lines of text. There the sidebar opens only on `/pitbox`.
- The cost tile is the whole session's estimate, as `/cost` gives it, not the bill.
- A running phase's bar is drawn half full: Pitbox does not know how far along a phase is.
- A phase is not marked done when its branch merges; the task list has to say so.

## License

MIT
