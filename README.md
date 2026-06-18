<!-- LANGUAGE-SELECTOR-START -->
**Language:** English | [Español](translations/es/README.md) | [Português (Brasil)](translations/pt/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![npm version](https://img.shields.io/npm/v/@egchq/egc?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@egchq/egc) [![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Discord](https://img.shields.io/discord/1513941515452416130?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/AtazrtxJ) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](.github/CONTRIBUTING.md) [![Stars](https://img.shields.io/github/stars/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/stargazers) [![Forks](https://img.shields.io/github/forks/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/network/members) [![Issues](https://img.shields.io/github/issues/Fmarzochi/EGC)](https://github.com/Fmarzochi/EGC/issues) [![Maintained](https://img.shields.io/badge/Maintained-yes-brightgreen)](https://github.com/Fmarzochi/EGC/commits/main) [![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC)

<!-- CENTERED-LANGUAGE-SELECTOR-START -->
<div align="center">

**Language / Idioma**

[**English**](README.md) | [Español](translations/es/README.md) | [Português (Brasil)](translations/pt/README.md)

</div>
<!-- CENTERED-LANGUAGE-SELECTOR-END -->

<div align="center">

# EGC - Extended Global Context

**Your AI agents never start from zero again.**

</div>

---

EGC is a local runtime that gives every AI coding tool you use a persistent memory. At the end of each session, the AI saves what it learned about your project: the decisions you made, what failed, your preferences, what comes next. At the start of the next session, it loads that state back. One install covers Claude Code, Cursor, Gemini CLI, Windsurf, and more.

---

## This is what EGC looks like in practice

You open Claude Code on a project you haven't touched in two weeks. Without typing anything:

```
State loaded from egc-memory via ~/.egc/state/Projects--MyApp.md

Context and preferences acknowledged (terse responses).

Ready to pick up the next items:
• Test full install on a clean machine
• Add GEMINI.md with session memory protocol
• Publish v1.0.1 fix to npm after clean install test passes
• Add mcp_server_count to audit.js
```

The AI already knows what you were building, what decisions you made, what failed, and exactly where you stopped. It knows because EGC saved that state at the end of your last session and loaded it back when this one started. You didn't type anything. You just started working.

<div align="center">
  <img src="assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## Install

```bash
npm install -g @egchq/egc && egc install
```

Or run without installing globally:

```bash
npx @egchq/egc install
```

[Full installation guide](docs/installation.md)

---

## What the MCP server gives your AI

EGC ships `egc-memory`, an MCP server that exposes 14 tools your AI can call during a session:

| Tool | What it does |
|---|---|
| `get_state` | Loads project memory at session start |
| `update_state` | Saves decisions, preferences, and next steps |
| `store_decision` | Persists a single decision to SQLite |
| `query_history` | Returns past decisions by timestamp |
| `search_history` | Full-text search with BM25 ranking |
| `working_memory_set` | Stores transient context with a TTL |
| `working_memory_get` | Reads a transient key |
| `working_memory_list` | Lists all live transient entries for the current project |
| `lesson_save` | Records cross-session knowledge with confidence decay |
| `lesson_recall` | Retrieves active lessons above a confidence threshold |
| `lesson_reinforce` | Boosts confidence on a lesson when the same pattern repeats |
| `detect_patterns` | Surfaces repeated commands and recurring errors from hook events |
| `compress_observations` | Compresses raw hook observations into typed summaries to reduce token usage |
| `get_project_state` | Returns server health metadata and storage engine status |

State files live at `~/.egc/state/<project-slug>.md`. One file per project, plain Markdown, human-readable.

---

## Prompt library

**479 components**: optional. Install to get access to 63 agents, 229 skills, and 76 commands written from real experience. Skip them and EGC still gives you persistent memory.

| Component | Total | Claude Code | Gemini CLI | Claude Code native |
|---|---|---|---|---|
| Agents | 63 | Shared (AGENTS.md) | Shared (AGENTS.md) | 12 |
| Commands | 76 | Shared | Instruction-based | 31 |
| Skills | 229 | Shared | 10 (native format) | 37 |
| Rules | 111 |: |: |: |

---

## Support EGC

EGC is built by one developer, maintained in the open, and free.

- **[Join the Discord](https://discord.gg/AtazrtxJ)**: ask questions, share feedback
- **[Sponsor on GitHub](https://github.com/sponsors/Fmarzochi)**: any amount
- **[Donate via PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: no GitHub account needed
- **Star the repository**: helps other developers find it
- **[Contribute](.github/CONTRIBUTING.md)**: agents, skills, commands, bug fixes, docs
- **Share**: if EGC changed how you work, tell someone

### Sponsors

Support from the community keeps this project alive and independent.

**Backers**

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="48" height="48" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

**Monthly sponsors** · _be the first_

---

<div align="center">

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
