<!-- LANGUAGE-SELECTOR-START -->
🌐 **English** · [العربية](translations/ar/README.md) · [Deutsch](translations/de/README.md) · [Español](translations/es/README.md) · [Français](translations/fr/README.md) · [हिन्दी](translations/hi/README.md) · [Italiano](translations/it/README.md) · [日本語](translations/ja/README.md) · [한국어](translations/ko/README.md) · [Português (Brasil)](translations/pt/README.md) · [Русский](translations/ru/README.md) · [Türkçe](translations/tr/README.md) · [简体中文](translations/zh-CN/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - Give Every AI Agent the Same Brain

**One local engine that gives every AI coding tool on your machine the same memory, the same guardrails and the same context, in every session.**

</div>

---

EGC is a local-first runtime for AI coding tools. Install it once and Cursor, Claude Code, Codex, Copilot, Aider and the rest of the 20 AI coding tools it supports share one encrypted memory of your projects, one safety layer in front of every command, one filter that keeps noisy output away from the model, and one live bus that lets your open sessions see each other. Works natively with Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere, and Vertex AI, plus OpenRouter for Qwen3, Llama 4, and more.

Nothing leaves your machine. Memory lives in `~/.egc`, encrypted with AES-256-GCM, kept per project and branch, and never committed to git.

---

## Install

```bash
npm install -g @egchq/egc && egc install
```

That is the whole engine. `egc install` detects the tools you have, registers the two local MCP servers in each of them, writes the memory protocol every agent reads, and sets up the Token Crusher. It asks one question, whether you also want the optional prompt library, and the default is no.

<div align="center">
  <img src="assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[Full installation guide](docs/installation.md)

---

## The Engine: How EGC Works

EGC is one brain with four faculties. Each one is on from the first install, in every supported tool, with no command to learn.

<div align="center">
  <img src="assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### Memory: What One Agent Learns, Every Agent Knows

Decisions, session context, working memory and learned lessons are captured as you work and are available in any other terminal, IDE or agent you open. You speak naturally, in any language: "save this session", "what did we decide about auth?", "remember this decision". EGC understands the intent and stores or recalls the context. There is no command to memorize.

### Session Mesh: Your Open Sessions See Each Other

Two Cursor tabs, a Claude Code terminal and an Antigravity session share one live bus. They announce what they are working on, claim the files they edit, hand work to each other and pick up events the moment they land, so parallel sessions cooperate instead of colliding.

### Guardian: A Safety Layer in Front of Every Command

Guardian validates commands before they run, gates risky writes and keeps context from overflowing, in the background, without you invoking anything. Coverage depends on each tool's own hook support; the [Security Assessment](docs/security/SECURITY-ASSESSMENT.md#known-limitations) documents the exception.

### Token Crusher: Noise Never Reaches the Model

Before shell output reaches the model, the Token Crusher compresses git logs, test spam, install noise and giant JSON by up to 90 percent while keeping every error and warning. Ask "how much did I save?" in any language and the answer comes straight from your local ledger.

---

## Quick Start

There is no step two. Open any of your AI tools and just talk: "hi", "let's continue", "remember this decision", in any language. Sessions connect, memory loads, and every open tab already knows what the others are doing.

A live dashboard with agent activity, tokens and costs starts right after installation. Prefer explicit control? Every command is documented in the [installation guide](docs/installation.md): you will probably never need to type one.

---

## Prompt Library (Optional)

Separate from the engine, and off by default, EGC also ships a library written from real engineering sessions: you get access to 61 agents, 232 skills, and 77 commands, plus 109 rules. Specialists that review your code on their own, best-practice guides for every language and situation, shortcuts that run a whole sequence of tasks, and style rules that keep your code consistent. Add it to every detected tool with `egc install --prompt-library`, or to one tool with `egc install --target <tool> --profile full`. Skip it and the engine works exactly the same.

---

🌐 **English** · [العربية](translations/ar/README.md) · [Deutsch](translations/de/README.md) · [Español](translations/es/README.md) · [Français](translations/fr/README.md) · [हिन्दी](translations/hi/README.md) · [Italiano](translations/it/README.md) · [日本語](translations/ja/README.md) · [한국어](translations/ko/README.md) · [Português (Brasil)](translations/pt/README.md) · [Русский](translations/ru/README.md) · [Türkçe](translations/tr/README.md) · [简体中文](translations/zh-CN/README.md)

---

## Support EGC

EGC is built by one developer, maintained in the open, and free. The engine is Apache-2.0 and stays free: if EGC ever offers something paid, it will be a team layer on top of it, never the memory on your machine.

- **[Website](https://fmarzochi.github.io/EGCSite)**: full docs, feature overview, and live demo
- **[Vision](docs/VISION.md)**: where EGC is going, and what stays free
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
