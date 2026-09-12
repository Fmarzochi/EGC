# Support Levels

EGC supports 20 AI coding tools, and every one of them gets the same install path, the same MCP registration and the same memory protocol; the [integration tiers](../spec/integration-tiers.md) are the map of how each one integrates. What differs is what the maintainers guarantee when a vendor changes something. This document says so, per tool, so nobody has to guess.

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

Amp, VS Code Copilot, Windsurf, Zed, Kiro, Trae, CodeBuddy, JetBrains Junie, Goose, Amazon Q Developer CLI, OpenHands, Aider, Cline, Warp and Qwen Code.

Each one installs and is tested in CI on Linux, macOS and Windows like the core tools. Where the vendor exposes no hook surface, Guardian and Token Crusher coverage is documented as absent in the integration tiers, not promised.

### Retired

Gemini CLI, Continue.dev and Roo Code, retired on 2026-08-16 after each vendor's own lifecycle decision. The adapter files stay in the tree, unregistered, for history and rollback.

## Moving between levels

A community-supported tool becomes core-supported when a steward takes it on (see [stewards](stewards.md)) or when the maintainer starts using it daily. A core-supported tool moves to community-supported when neither is true anymore; the change is announced in the changelog. Nothing is removed from the package by a level change.
