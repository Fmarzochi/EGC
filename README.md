<!-- LANGUAGE-SELECTOR-START -->
🌐 **English** · [العربية](translations/ar/README.md) · [Deutsch](translations/de/README.md) · [Español](translations/es/README.md) · [Français](translations/fr/README.md) · [हिन्दी](translations/hi/README.md) · [Italiano](translations/it/README.md) · [日本語](translations/ja/README.md) · [한국어](translations/ko/README.md) · [Português (Brasil)](translations/pt/README.md) · [Русский](translations/ru/README.md) · [Türkçe](translations/tr/README.md) · [简体中文](translations/zh-CN/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - Give Every AI Agent the Same Brain

**Persistent memory that every AI agent, IDE, terminal, and session shares automatically. No prompts to memorize. No context to rebuild. Just talk.**

</div>

---

EGC isn't another memory tool. It's the intelligence layer that lets every AI work as if it has been on your project since day one, in Cursor, Copilot, Claude Code, Codex, Aider, and any terminal agent (23 AI coding tools in total). Works natively with Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere, and Vertex AI, plus OpenRouter for Qwen3, Llama 4, and more.

Every conversation builds your project's collective intelligence. Every agent inherits it. Every session gets smarter.

---

## Install

```bash
npm install -g @egchq/egc && egc install
```

- **Reduce context waste by up to 90%, cut token costs, and keep every AI perfectly aligned across sessions.**
- **Guardian: validate every command before execution, block dangerous writes, and detect prompt injection. Every shared brain comes with a built-in safety layer.**
- **One command, zero config: memory stays local and encrypted on your machine, and never gets committed to git.**

<div align="center">
  <img src="assets/gifs/install.gif" alt="One command installs EGC across 23 AI coding tools" width="800" />
</div>

[Full installation guide](docs/installation.md)

---

## Inside the Brain: How EGC Works

EGC is not a list of tools; it is one brain with several faculties. It remembers, understands, protects, filters, and coordinates, across every AI agent on your machine.

<div align="center">
  <img src="assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### You Don't Memorize Commands, You Speak Naturally

Talk to the brain in any language: "save this session", "what did we decide about auth?", "remember this decision". EGC understands the intent, stores the context, and recalls it instantly in any other tab, terminal, or tool on your machine. One brain. Every agent. Zero commands to remember.

### Persistent Project Memory

EGC gives every AI agent a persistent, shared brain. It captures decisions, session context, working memory, and learned patterns, then makes them instantly available in any other terminal, IDE, or agent you open. Session state, project history, and accumulated lessons flow seamlessly between tabs, tools, and teammates: no manual sync, no context loss. All memory lives in `~/.egc` on your machine, encrypted with AES-256-GCM, kept per project branch, and never committed to your repository.

### Guardian: Built-In Safety Guardrails

A second half of the brain runs guardrails in the background. It validates commands before they execute, gates risky writes, compresses context before it overflows, orchestrates multi-step tasks across agents, and learns from every correction, all without you invoking a single tool. An invisible safety net that keeps context lean, actions safe, and workflows autonomous.

### Token Crusher: The Brain Filters Noise Before It Remembers

The brain doesn't just remember: it filters. Before any shell output reaches the model, EGC's Token Crusher compresses git logs, test spam, install noise, and giant JSONs by up to 90%, preserving every error and warning. Just ask "how much did I save?" in any language, and the answer comes straight from your local ledger at zero cost: cheaper sessions, context that lasts.

---

## Prompt Library

As a bonus, EGC gives you access to 63 agents, 230 skills, and 77 commands, plus 111 rules: specialists that review your code on their own, best-practice guides for every language and situation, shortcuts that run a whole sequence of tasks for you, and style rules that keep your code consistent. All written from real engineering sessions, not theory. Don't want to use any of it? Fine: EGC's persistent memory works exactly the same.

---

## Quick Start

There is no step two. Open any of your AI tools and just talk: "hi", "let's continue", "remember this decision", in any language. Sessions connect instantly, memory loads automatically, and every open tab already knows what the others are doing: two Cursor tabs, a Claude Code terminal, and an Antigravity session all share the same living context, simultaneously.

A live dashboard displaying agent activity, tokens, and costs spins up automatically right after installation. Prefer manual control? Every command is documented in the [installation guide](docs/installation.md): you will probably never need to type one.

---
🌐 **English** · [العربية](translations/ar/README.md) · [Deutsch](translations/de/README.md) · [Español](translations/es/README.md) · [Français](translations/fr/README.md) · [हिन्दी](translations/hi/README.md) · [Italiano](translations/it/README.md) · [日本語](translations/ja/README.md) · [한국어](translations/ko/README.md) · [Português (Brasil)](translations/pt/README.md) · [Русский](translations/ru/README.md) · [Türkçe](translations/tr/README.md) · [简体中文](translations/zh-CN/README.md)

---

## Support EGC

EGC is built by one developer, maintained in the open, and free.

- **[Website](https://fmarzochi.github.io/EGCSite)**: full docs, feature overview, and live demo
- **[Join the Discord](https://discord.gg/TxppsGb52)**: ask questions, share feedback
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
