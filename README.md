<!-- LANGUAGE-SELECTOR-START -->
🌐 **English** · [العربية](translations/ar/README.md) · [Español](translations/es/README.md) · [हिन्दी](translations/hi/README.md) · [日本語](translations/ja/README.md) · [한국어](translations/ko/README.md) · [Português (Brasil)](translations/pt/README.md) · [Русский](translations/ru/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC)

<div align="center">

# EGC - Extended Global Context

**Your AI agents never start from zero again.**

*Zero setup. Zero commands. You work, EGC remembers.*

</div>

---

EGC is a local runtime that gives every AI coding tool you use a persistent memory. At the end of each session, your AI saves what it learned: decisions made, what failed, your preferences, what to pick up next. At the start of the next session, it loads that state back on its own, no prompting required. Say "let's continue" or "where did we stop?" in any language and your AI already knows what to do. One install covers Claude Code, Cursor, Gemini CLI, Windsurf, Zed, VS Code with GitHub Copilot, and more. Works with Claude, GPT-4o, Gemini, and OpenRouter models including DeepSeek, Qwen3, and Llama 4.

---

## Your AI already knows

You open Claude Code on a project you haven't touched in two weeks. Without typing anything:

```
State loaded from egc-memory via ~/.egc/state/MyApp/main.md

Context and preferences acknowledged.

Ready to pick up:
• Fix the rate limiter edge case on concurrent requests
• Add integration tests for the new auth module
• Review open PR from @contributor before merging

=== EGC Stack Briefing ===
Stack: typescript, node
Skills: tdd-workflow, coding-standards
Agents: code-reviewer
Guardian: active, every command checked before it runs
===
```

This isn't a cache of your last chat. EGC remembers the decisions, the dead ends, and your preferences, and it stands guard the whole session, blocking the commands that would burn your codebase down before they run. You didn't ask for any of it. You just started working.

<div align="center">
  <img src="assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## Install

🪟 Windows &nbsp;&middot;&nbsp; 🍎 macOS &nbsp;&middot;&nbsp; 🐧 Linux, same command everywhere:

```bash
npm install -g @egchq/egc && egc install
```

Or run without installing globally:

```bash
npx @egchq/egc install
```

**One brain, many tools.** With the GitHub Copilot Chat extension installed, Copilot finds the skills on its own, and the same memory you already have in Claude Code or Cursor shows up there too:

```bash
npm install -g @egchq/egc
egc install --target copilot
```

[Full installation guide](docs/installation.md)

---

## What EGC gives your AI

EGC always runs two things together, every session: a memory that keeps what matters, and a safety layer that blocks dangerous commands before they run. It all comes ready, no configuration needed.

### Memory: what your AI remembers on its own

You'll never memorize a single command. Say it in any language: "continue from yesterday", "remember this decision", "what broke last time", and your AI knows exactly what to do. The work is yours, the remembering is EGC's.

**`egc-memory`**

| Tool | What it does |
|---|---|
| `get_state` | Loads everything your AI already knew about the project the moment the session opens |
| `update_state` | Saves what got decided today so nobody loses the thread tomorrow |
| `store_decision` | Writes down one important decision, for good |
| `query_history` | Shows past decisions in the order they happened |
| `search_history` | Finds anything that was ever decided, even if you don't remember the date |
| `working_memory_set` / `_get` / `_list` | Quick notes that expire on their own once they stop being useful |
| `lesson_save` | Records something learned, which fades over time if nobody confirms it again |
| `lesson_recall` | Brings back the lessons that are still worth acting on |
| `lesson_reinforce` | Reinforces a lesson when it gets confirmed again |
| `detect_patterns` | Notices when the same error or command keeps repeating |
| `compress_observations` | Summarizes the raw history so you don't burn tokens for nothing |
| `get_project_state` | Checks that memory is working the way it should |

Every branch of your project keeps its own memory, encrypted on your machine: nobody else has access, not even the cloud. Privacy by default, nothing to configure.

### Context and safety: what stands guard while you work

**`egc-guardian`**

These tools run automatically in the background. Every shell command and every file write is checked before it executes. You never invoke them directly.

| Tool | What it does |
|---|---|
| `validate_command` | Checks every command before it runs: blocks the ones that could cause damage |
| `validate_write` | Stops the AI from writing to sensitive files by accident |
| `reduce_context` | Shrinks large files so you don't burn your token budget for nothing |
| `orchestrate_task` | Picks the right tools for each request, without you needing to know which ones exist |
| `auto_learn` | Learns from the session's mistakes and writes it down so it doesn't repeat |

### Enforced, not requested

Security that doesn't depend on the AI being in a good mood: every command passes through EGC before it runs, always. [Full details on harness enforcement, session-intent detection, and the memory miner →](docs/installation.md#enforcement)

### One memory. Every tool you use.

Run **`egc watch`** once and forget it exists. Change context in Cursor, it shows up on its own in Gemini CLI, Copilot, Windsurf, Zed: everywhere you work. No manual steps, no stale state anywhere.

```
egc watch              # watch current project
egc watch /path/proj   # watch a specific project
egc watch --quiet      # suppress output
```

### Dashboard: watch your agents work

See every tool call, token, and cost your agents generate, live in your browser. Starts automatically after `egc init`. [Full guide](docs/installation.md#dashboard)

---

## Prompt library

As a bonus, EGC gives you access to 63 agents, 230 skills, and 77 commands, plus 111 rules: specialists that review your code on their own, best-practice guides for every language and situation, shortcuts that run a whole sequence of tasks for you, and style rules that keep your code consistent. All written from real engineering sessions, not theory. Don't want to use any of it? Fine: EGC's persistent memory works exactly the same.

---

🌐 **English** · [العربية](translations/ar/README.md) · [Español](translations/es/README.md) · [हिन्दी](translations/hi/README.md) · [日本語](translations/ja/README.md) · [한국어](translations/ko/README.md) · [Português (Brasil)](translations/pt/README.md) · [Русский](translations/ru/README.md)

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

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
