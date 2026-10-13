# Support Levels

EGC supports 29 AI coding tools, and every one of them gets the same install path; all but one also get the same MCP registration and the same memory protocol, Letta Code being the exception since neither is documented for its CLI. The [integration tiers](../spec/integration-tiers.md) are the map of how each one integrates. What differs is what the maintainers guarantee when a vendor changes something. This document says so, per tool, so nobody has to guess.

## The two levels

| Level | What it means |
|---|---|
| **Core-supported** | The maintainer or an area steward runs the tool daily. Guardian and Token Crusher hooks are wired. A regression caused by a vendor change is treated as a bug in EGC: it gets an issue, a fix and a test before the next release. |
| **Community-supported** | The tool is installed, registered and covered by the same test suites in CI, and it works today. A vendor change that breaks it waits for a report or a pull request; the maintainer reviews and merges, the community carries the fix. A steward who owns the tool moves it to core-supported. |

Retired tools are listed for history only; their adapters left the registry.

## Current assignment

Criteria, in this order: whether the maintainer or a steward uses the tool every day, whether the Guardian and the Token Crusher are wired through the tool's own hook surface, and how much of the test suite exercises the adapter.

### Core-supported

| Tool | Why |
|---|---|
| Claude Code | Daily driver of the maintainer; hooks for Guardian, Token Crusher and the mesh turn signal; the most exercised adapter after Cursor. |
| Antigravity | Daily driver of the maintainer; hooks for Guardian and the mesh turn signal; the home the `egc` target owns. |
| Cursor | The most exercised adapter in the test suite; Guardian wired through Cursor's own hooks. |
| Codex CLI | Daily driver of the maintainer; hooks for Guardian and the mesh turn signal. |
| OpenCode | Native plugin for Guardian and Token Crusher, kept honest through two rounds of real-machine bisects on Windows. |

### Community-supported

Amp, VS Code Copilot, Devin Desktop, Zed, Kiro, Trae, CodeBuddy, JetBrains Junie, Goose, OpenHands, Aider, Cline, Warp, Qwen Code, Kimi Code CLI (skills flat under `~/.kimi-code/skills/`, MCP in `mcp.json`, and the Guardian as a `PreToolUse` `[[hooks]]` table in `config.toml`; `KIMI_CODE_HOME` moves its root, and the Token Crusher is out of scope because its hooks cannot rewrite a command), Crush (Charmbracelet; its skills share the `~/.agents` root with Codex, Goose and OpenHands, and its subagents are currently read-only), Auggie (Augment Code; no hook or plugin API with an allow/deny decision is documented, so the Guardian and the Token Crusher are out of scope), Mistral Vibe (its `hooks.toml` runs the Guardian and the Token Crusher as `pre_tool` hooks, `VIBE_HOME` moves its root, and its project files load in trusted folders only), Grok Build (skills under `~/.grok/skills/`, the memory protocol in `~/.grok/AGENTS.md`, and the Guardian as a `PreToolUse` hook file in `~/.grok/hooks/`; `GROK_HOME` moves its root), Kilo Code CLI (an OpenCode fork: skills, agents and commands under `~/.config/kilo/`, or `$XDG_CONFIG_HOME/kilo/` when that is set to an absolute directory, the memory protocol in its `AGENTS.md`, and the Guardian and the Token Crusher through the same in-process plugin as OpenCode), MiMo Code (another OpenCode fork, from Xiaomi: the same layout under its config directory, `MIMOCODE_HOME` moving it), Pi (skills, prompt templates and `AGENTS.md` under `~/.pi/agent`, which `PI_CODING_AGENT_DIR` moves, the Guardian and the Token Crusher as a `tool_call` extension, MCP built in; checked against Pi's docs and source, not yet against a running install), Droid from Factory (skills, commands and `AGENTS.md` under `~/.factory`, the Guardian and the Token Crusher as Claude-shaped hooks in its `settings.json`; checked against Factory's docs, not yet against a running install), and Letta Code (skills flat under `~/.letta/skills/`, the only global root its CLI reads; no MCP config file, hook surface or rules file is documented, so there is no Guardian, Token Crusher or memory protocol here, and agents, commands, rules and `AGENTS.md` ship only as reference copies under `egc/library/`; checked against Letta's docs, not yet against a running install).

Each one installs and is tested in CI on Linux, macOS and Windows like the core tools. Where the vendor exposes no hook surface, Guardian and Token Crusher coverage is documented as absent in the integration tiers, not promised.

### Retired

Gemini CLI, Continue.dev and Roo Code, retired on 2026-08-16 after each vendor's own lifecycle decision. The adapter files stay in the tree, unregistered, for history and rollback.

## Moving between levels

A community-supported tool becomes core-supported when a steward takes it on (see [stewards](stewards.md)) or when the maintainer starts using it daily. A core-supported tool moves to community-supported when neither is true anymore; the change is announced in the changelog. Nothing is removed from the package by a level change.
