[![npm](https://img.shields.io/npm/v/everything-gemini?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/everything-gemini) [![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md) [![Stars](https://img.shields.io/github/stars/Fmarzochi/everything-gemini?style=social)](https://github.com/Fmarzochi/everything-gemini/stargazers) [![Forks](https://img.shields.io/github/forks/Fmarzochi/everything-gemini?style=social)](https://github.com/Fmarzochi/everything-gemini/network/members) [![Issues](https://img.shields.io/github/issues/Fmarzochi/everything-gemini)](https://github.com/Fmarzochi/everything-gemini/issues)

<div align="center">

# EGC — Everything Gemini Code

**Your AI remembers what you decided, how you work, and where you left off. Across every session. Across every tool.**

</div>

---

<img src="assets/hero.png" alt="EGC — Everything Gemini Code" width="100%" />

---

## This is what EGC looks like in practice

You open AGY on a project you haven't touched in two weeks. Without typing anything:

```
State loaded from egc-memory via ~/.egc/state/Projetos--everything-gemini.md

Context and preferences acknowledged (no AI attribution, terse responses).

Ready to pick up the next items:
• Test full install on a clean machine
• Add GEMINI.md with session memory protocol
• Tag v1.0.0 after clean install test passes
• Add mcp_server_count to audit.js
```

The AI already knows what you were building, what decisions you made, what failed, and exactly where you stopped. You didn't type anything. You just started working.

---

## The problem

Every AI coding session starts from zero. Close the window and the context is gone — your stack preferences, the architectural decisions you made last week, the approach that failed after three attempts. Next session you spend the first ten minutes re-explaining ground you already covered.

It gets worse when you switch tools. Move from Cursor to Claude Code and you start over again. The AI doesn't know you. It never did.

---

## How EGC fixes it

One install. Every tool. Permanent memory.

`sh install.sh` detects which AI tools you have installed — Cursor, Claude Code, AGY, Kiro, Codex, OpenCode — and wires up memory hooks in all of them automatically. From that point on:

- **Open any session** → hook fires → AI reads your project state → picks up where you left off
- **Close any session** → hook fires → AI saves decisions, preferences, next steps
- **Switch tools** → same state file → same context → no re-explaining

The memory lives at `~/.egc/state/` on your machine, not inside any tool. It follows the project, not the IDE.

---

## Token savings

Rebuilding context from scratch costs ~1,500 tokens per session. EGC's state file delivers the same information in ~200 tokens.

| | Without EGC | With EGC |
|---|---|---|
| Context overhead per session | ~1,500 tokens | ~200 tokens |
| 20 sessions/month (Claude Sonnet) | ~$0.09 | ~$0.012 |
| 20 sessions/month (GPT-4o) | ~$0.075 | ~$0.010 |
| Time re-explaining context | 10 min/session | 0 |

The money saved is small. The time and interrupted flow are not.

---

## Installation

### Linux / macOS

You need [Node.js 18 or later](https://nodejs.org/en/download). Not sure if you have it? Open a terminal and run `node --version`. If it shows 18 or higher, you're ready.

```bash
git clone https://github.com/Fmarzochi/everything-gemini.git
cd everything-gemini
sh install.sh
```

The installer will print which tools it found and registered:

```
EGC install
  node v22.0.0
  building egc-guardian...
  building egc-memory...
  initializing database...
  registering MCP servers...
  ✓ registered in Antigravity CLI
  ✓ registered in Claude Code (global)
  ✓ registered in Cursor

Installation complete.
Run 'egc doctor' to verify.
```

### Windows

```powershell
git clone https://github.com/Fmarzochi/everything-gemini.git
cd everything-gemini
.\install.ps1
```

---

## Prompt library

Install once to get access to 62 agents, 228 skills, and 74 commands — written from real experience, not generated.

| Type | Count | What it is |
|---|---|---|
| Agents | 62 agents | Persona and behavior definitions |
| Skills | 228 skills | Domain-specific workflow runbooks |
| Commands | 74 commands | Command definitions and lifecycle hooks |
| Rules | 110 | Constraints and governance directives |

Organized per harness under `.cursor/`, `.claude/`, `.gemini/`, `.kiro/`, and four others. Switch tools and the same workflows follow you.

### Cross-harness distribution

| Component | Total | Claude Code | Gemini CLI | Claude Code native |
|---|---|---|---|---|
| Agents | 62 | Shared (AGENTS.md) | Shared (AGENTS.md) | 12 |
| Commands | 74 | Shared | Instruction-based | 31 |
| Skills | 228 | Shared | 10 (native format) | 37 |

---

## Supported tools

| Tool | Auto-registered by installer |
|---|---|
| Claude Code | Yes |
| Antigravity CLI (AGY) | Yes |
| Cursor | Yes |
| Kiro | Yes |
| Codex CLI | Yes |
| OpenCode | Yes |
| Gemini CLI | Yes |
| CodeBuddy | Context injection |
| Trae | Context injection |
| Obsidian | Yes — if already configured, synced to all tools |

If you use Obsidian and have the [Obsidian MCP server](https://github.com/MarkusPfundstein/mcp-obsidian) configured, the installer detects it automatically and gives every AI tool in your setup direct access to your vault — read notes, search, write — without any extra configuration.

---

## MCP servers

EGC runs two local MCP servers over stdio.

**egc-memory** — the one you'll use every session

| Tool | What it does |
|---|---|
| `get_state` | Reads project memory at session start |
| `update_state` | Saves this session's decisions, preferences, and next steps |
| `store_decision` | Persists a decision to SQLite |
| `query_history` | Returns past decisions by timestamp |

**egc-guardian** — runs in the background

| Tool | What it does |
|---|---|
| `validate_command` | Blocks shell injection and unsafe binaries |
| `validate_write` | Blocks writes to sensitive paths (`~/.ssh`, `/etc`) |
| `reduce_context` | Deduplicates and trims Markdown payloads |
| `orchestrate_task` | Routes prompts to relevant agents and skills |

---

## CLI

```bash
egc doctor    # verify both servers are built and working
egc status    # show the last 5 decisions in memory
egc init      # reinitialize ~/.egc/ if needed
egc config    # print the MCP server configuration
```

---

## Architectural consolidation

Earlier versions of EGC explored distributed runtime concepts — FederationManager, ReplayEngine, cognitive orchestration layers, multi-provider dispatching. Those experiments were real explorations, not deception. They helped define what the project actually needed to be.

What the project actually needed was simpler and more useful: persistent memory across sessions, a validation layer, and a prompt library that works in every tool without reconfiguration.

The current runtime reflects that consolidation. Two MCP servers, local SQLite, plain Markdown state files, one install command. Everything else was removed or isolated.

The branch `legacy-runtime` preserves the full historical architecture for anyone who wants to study the evolution.

---

## License [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

<p align="center">
  <img src="assets/images/egc-logo.png" alt="EGC Logo" width="80" /><br/>
  Desenvolvido por <a href="https://linkedin.com/in/felipemarzochi">Felipe Marzochi</a>
</p>
