# Token Optimization

EGC spends tokens in four places: shell output that reaches the model, files loaded into context, memory the agent has to re-read, and the instructions every session carries. This page lists the controls the package ships for each, the setting to reach for first, and what each one trades away. Every command below exists in this repository; nothing here needs an API key.

## 1. Shell output: the Token Crusher

Noisy commands (long `git log` and `git diff`, test runners, package installs, large `gh --json` payloads) are the biggest single source of wasted tokens. The Token Crusher compresses that output before the model sees it, by up to 90 percent, and always keeps errors, warnings and failures.

| Control | What it does | When to use it |
|---|---|---|
| `egc run <command>` | Runs any command and returns the crushed output | Default for git, tests, installs, `gh` |
| `egc run --raw <command>` | Same command, full output | Debugging a failure the summary hides |
| `egc saved` | Accumulated savings, computed locally | A quick answer to "how much did I save?" |
| `egc gain` | Full savings panel: totals, efficiency, breakdown by command kind | Weekly review |
| `egc gain --history` | The run-by-run savings log | Auditing a specific session |
| `egc discover` | Scans recent transcripts for crushable output that skipped the crusher | Finding commands that still run uncrushed |
| `egc crusher-shim install` | PATH-level shim for git, npm, pnpm, yarn, bun, pip, poetry, uv, composer, bundle and gh | Harnesses where the hook rewrite does not fire |

Target setting: keep the crusher hook enabled and the shim installed. On hook-capable harnesses the bash dispatcher routes simple commands through `egc run` on its own; the rewrite is fail-open, so pipelines, chaining, redirection and already-wrapped commands pass through untouched.

Tradeoff: crushed output is a summary. When a test fails for a reason the summary does not show, rerun the same command with `--raw` once rather than switching the crusher off. On Claude Code the hook rewrite applies only to commands a human types, not to commands the assistant issues through its Bash tool; the assistant has to prefix `egc run` itself, and the shim covers the common binaries either way (see [installation.md](installation.md#token-crusher)).

## 2. Files in context: `reduce_context` and the budget skills

The Guardian MCP server exposes `reduce_context`, which loads the files a task needs and trims each payload before it enters the context window; `orchestrate_task` reports the same reduction metrics for any file paths passed to it. Use it instead of reading large files whole.

Skills that manage the window itself:

- `strategic-compact` suggests manual compaction at logical boundaries of the work (after a plan is approved, after a suite goes green) instead of waiting for automatic compaction mid-task.
- `context-budget` audits what agents, skills, MCP servers and rules consume in every session and lists what to trim.
- `token-budget-advisor` sizes a task's budget before it starts.
- `cost-aware-llm-pipeline` covers model routing, budget tracking and prompt caching for applications built with LLM APIs.

Target setting: compact at a boundary you choose. Tradeoff: compaction summarizes the transcript; the project memory below is what keeps decisions from being lost when it happens.

## 3. Memory: read state instead of re-explaining

The memory server persists decisions, failures, preferences and next steps per project and branch. `get_state` at session start restores them in one call; `update_state` at the end writes what changed. The lifecycle hooks in [hooks/memory-persistence](../hooks/memory-persistence/) load that state on `SessionStart` and save it on `PreCompact`, `Stop` and `SessionEnd`, so a compaction or an abrupt exit never costs a re-explanation.

Tradeoff: state files grow with the project. Keep the sections short and let `update_state` merge instead of appending transcripts.

## 4. Instructions every session carries

Every rule file installed in a tool's rules directory loads into every session. The full profile therefore installs the common rules once per tool and leaves the Chinese mirror of those rules out of the Claude Code target, where each duplicate would have cost several thousand tokens per session for no gain. When you add rules of your own, prefer path-scoped rules (the `paths:` frontmatter) so a rule loads only when a matching file is in play.

Model choice is a budget lever too: `/model-route` recommends the cheapest tier that fits the task's complexity and risk, and `/cost-report` reads the local cost-tracker database when that hook is enabled.

## Measuring

`egc gain` is the ledger. Run it before and after changing any setting on this page; a setting that does not move the numbers is not worth keeping.
