<!-- LANGUAGE-SELECTOR-START -->
**Language:** English | [العربية](translations/ar/README.md) | [Español](translations/es/README.md) | [हिन्दी](translations/hi/README.md) | [한국어](translations/ko/README.md) | [Português (Brasil)](translations/pt/README.md) | [Русский](translations/ru/README.md) | [日本語](translations/ja/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![npm version](https://img.shields.io/npm/v/@egchq/egc?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@egchq/egc) [![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Discord](https://img.shields.io/discord/1513941515452416130?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/AtazrtxJ) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](.github/CONTRIBUTING.md) [![Stars](https://img.shields.io/github/stars/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/stargazers) [![Forks](https://img.shields.io/github/forks/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/network/members) [![Issues](https://img.shields.io/github/issues/Fmarzochi/EGC)](https://github.com/Fmarzochi/EGC/issues) [![Maintained](https://img.shields.io/badge/Maintained-yes-brightgreen)](https://github.com/Fmarzochi/EGC/commits/main) [![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC) [![Featured on Product Hunt](https://img.shields.io/badge/Product%20Hunt-featured-DA552F?logo=producthunt&logoColor=white)](https://www.producthunt.com/posts/egc)

<!-- CENTERED-LANGUAGE-SELECTOR-START -->
<div align="center">

**Language / اللغة / Idioma / भाषा / 언어 / Язык / 言語**

[**English**](README.md) | [العربية](translations/ar/README.md) | [Español](translations/es/README.md) | [हिन्दी](translations/hi/README.md) | [한국어](translations/ko/README.md) | [Português (Brasil)](translations/pt/README.md) | [Русский](translations/ru/README.md) | [日本語](translations/ja/README.md)

</div>
<!-- CENTERED-LANGUAGE-SELECTOR-END -->

<div align="center">

# EGC - Extended Global Context

**Your AI agents never start from zero again.**

*No commands to learn. Just work - EGC handles the rest.*

</div>

---

EGC is a local runtime that gives every AI coding tool you use a persistent memory. At the end of each session, your AI saves what it learned: decisions made, what failed, your preferences, what to pick up next. At the start of the next session, it loads that state back on its own - no prompting required. Say "let's continue" or "where did we stop?" in any language and your AI already knows what to do. One install covers Claude Code, Cursor, Gemini CLI, Windsurf, and more. Works with Claude, GPT-4o, Gemini, and OpenRouter models including DeepSeek, Qwen3, and Llama 4.

---

## This is what EGC looks like in practice

You open Claude Code on a project you haven't touched in two weeks. Without typing anything:

```
State loaded from egc-memory via ~/.egc/state/Projects-MyApp.md

Context and preferences acknowledged (terse responses).

Ready to pick up the next items:
• Test full install on a clean machine
• Add GEMINI.md with session memory protocol
• Publish v1.0.1 fix to npm after clean install test passes
• Add mcp_server_count to audit.js

=== EGC Stack Briefing ===
Stack: typescript, javascript
Stack agents: typescript-reviewer, javascript-reviewer
Always use: code-reviewer
Skill: coding-standards (cyclomatic complexity) - apply to all code written this session
===
```

The AI already knows what you were building, what decisions you made, what failed, and exactly where you stopped. It knows because EGC saved that state at the end of your last session and loaded it back when this one started - on its own, without you asking. You didn't type anything. You just started working.

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

## What EGC gives your AI

EGC ships two MCP servers that work together during every session.

### Memory - 14 tools that your AI uses automatically

No commands to memorize. Your AI reads this table so you never have to. Say anything in any language - "continue from yesterday", "remember this decision", "what broke last time?" - and it calls the right tool. You just work. EGC handles the rest.

**`egc-memory`**

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

### Context and safety - 5 tools for when things get heavy

**`egc-guardian`**

These tools run automatically in the background. Every shell command and every file write is checked before it executes. You never invoke them directly.

| Tool | What it does |
|---|---|
| `validate_command` | Checks shell commands against project safety rules before execution |
| `validate_write` | Validates file write paths to prevent unsafe writes |
| `reduce_context` | Compresses file payloads to save your token budget |
| `orchestrate_task` | Routes prompts with agent/skill context and returns compression metrics |
| `auto_learn` | Mines session failures and writes actionable lessons to all AI tool config files in the project |

### Enforced, not requested

Validation does not depend on the AI choosing to cooperate. EGC installs harness hooks that run on every tool call: each shell command and file write is validated before it executes, and destructive commands, credential paths, and force-pushes are blocked even inside compound commands. Every prompt is also routed against the component catalog so the right skills and agents are injected into context. If the validator is ever missing, hooks fail open so you are never locked out of your own tool.

With a provider API key (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`), EGC also understands session intent semantically, in any language, with no predefined phrases: say you are done for the night and your state is saved before the AI even answers; greet it the next morning and your next steps are already in context. At session end a memory miner distills the session's decisions and lessons into your project state. Without a key these LLM features honestly do nothing, and the lifecycle hooks still guarantee your state is saved.

### Always in sync - across every tool you use

**`egc watch`** - run it once and every tool you use stays in sync. Edit context in Cursor and it appears in Gemini CLI, Copilot, Windsurf, and everywhere else automatically. When your state updates, all your tool config files update with it. No manual steps, no stale state.

```
egc watch              # watch current project
egc watch /path/proj   # watch a specific project
egc watch --quiet      # suppress output
```

### Dashboard - real-time Mission Control

See every tool call, token, and cost your agents generate -- live in your browser. Starts automatically after `egc init`. [Full guide](docs/installation.md#dashboard)

---

## Prompt library

**479 components** included as a bonus. Install to get access to 63 agents, 229 skills, and 76 commands, plus 111 rules, all written from real engineering sessions. Skip them entirely and EGC still gives you persistent memory.

---

## Support EGC

EGC is built by one developer, maintained in the open, and free.

- **[Website](https://fmarzochi.github.io/EGCSite)**: full docs, feature overview, and live demo
- **[Join the Discord](https://discord.gg/AtazrtxJ)**: ask questions, share feedback
- **[Sponsor on GitHub](https://github.com/sponsors/Fmarzochi)**: any amount
- **[Donate via PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: no GitHub account needed
- **Star the repository**: helps other developers find it
- **[Contribute](.github/CONTRIBUTING.md)**: agents, skills, commands, bug fixes, docs
- **Share**: if EGC changed how you work, tell someone

### Sponsors

Support from the community keeps this project alive and independent.

#### Tool Partners

AI coding tools that integrate natively with EGC. Partners get logo placement across all READMEs and EGCSite.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### Annual Sponsors · _Be the first annual sponsor._

---

#### Backers

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### Monthly sponsors · _be the first_

---

<div align="center">

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
