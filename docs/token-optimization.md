# Token Optimization

EGC spends tokens in five places: shell output that reaches the model, files loaded into context, memory the agent has to re-read, the instructions every session carries, and the tool definitions of MCP servers. This page maps each of them to the control the package ships and to what that control trades away. The settings, the model choice and the compaction commands are covered step by step in the [guide](guides/token-optimization.md); this page does not repeat them.

## 1. Shell output: the Token Crusher

The Token Crusher compresses noisy command output (long `git log` and `git diff`, test runners, package installs, large `gh --json` payloads) by up to 90 percent before the model sees it, and always keeps errors, warnings and failures. `egc run <command>` is the door, `egc run --raw <command>` the escape hatch, `egc saved`, `egc gain` and `egc gain --history` the ledger, `egc discover` the scan for output that skipped the crusher, and `egc crusher-shim install` the PATH-level shim for the common binaries. The guide's [Token Crusher](guides/token-optimization.md#token-crusher-built-into-egc) section and the [installation page](installation.md#token-crusher) carry the details.

Tradeoff: crushed output is a summary. When a failure hides behind it, rerun the same command once with `--raw` instead of switching the crusher off. On Claude Code the hook runs on every Bash call, but the rewritten command is applied only when a person typed it, so for a command the assistant issues the assistant prefixes `egc run` itself; the shim covers the common binaries either way.

## 2. Files in context: `reduce_context`

The Guardian MCP server exposes `reduce_context`, which loads the files a task needs and trims each payload before it enters the context window; `orchestrate_task` reports the same reduction metrics for any file paths passed to it. Use it instead of reading large files whole. For the window itself, the `strategic-compact` skill suggests manual compaction at logical boundaries of the work, `context-budget` audits what agents, skills, MCP servers and rules consume in every session, `token-budget-advisor` sizes a task before it starts, and `cost-aware-llm-pipeline` covers routing, budgets and prompt caching for applications built with LLM APIs.

Tradeoff: compaction summarizes the transcript; the project memory below is what keeps decisions from being lost when it happens.

## 3. Memory: read state instead of re-explaining

The memory server persists decisions, failures, preferences and next steps per project and branch. `get_state` at session start restores them in one call; `update_state` at the end writes what changed. The lifecycle hooks in [docs/hooks/memory-persistence](hooks/memory-persistence/) load that state on `SessionStart` and save it on `PreCompact`, `Stop` and `SessionEnd`, so a compaction or an abrupt exit never costs a re-explanation.

Tradeoff: state files grow with the project. Keep the sections short and let `update_state` merge instead of appending transcripts.

## 4. Instructions every session carries

Every rule file installed in a tool's rules directory loads into every session. The full profile therefore installs the common rules once per tool and leaves the Chinese mirror of those rules out of the Claude Code target, where each duplicate would have cost several thousand tokens per session for no gain. When you add rules of your own, prefer path-scoped rules (the `paths:` frontmatter) so a rule loads only when a matching file is in play.

## 5. MCP servers

Every MCP server a tool has enabled adds its tool definitions to every session, whether or not a task uses them, so an unused server is a fixed cost on every prompt. `egc init` writes its own two entries, `egc-guardian` and `egc-memory`, into each tool's MCP settings and leaves every other entry alone. Disable the servers you do not use in that same settings file, or with the tool's own command for it; the guide's [MCP Server Management](guides/token-optimization.md#mcp-server-management) section names the command per tool. `EGC_DISABLED_MCPS` filters the EGC entries the installer and the Codex merge write; it never touches a server the tool loaded at runtime. Prefer a CLI that is already on the machine over an MCP server that wraps the same service (`gh` over a GitHub server, for example): the command costs tokens only when it runs.

## Measuring

`egc gain` is the ledger. Run it before and after changing any setting on this page; a setting that does not move the numbers is not worth keeping.
