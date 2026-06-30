# Contributing to EGC - Extended Global Context

Welcome to the engineering governance guide for **Extended Global Context (EGC)**. This is not just a collection of prompts or scripts; it is a cross-platform AI operating system and runtime orchestration fabric.

Because EGC operates as a structured engineering platform, contributions must align with our core architecture, ensuring the stability, observability, and deterministic execution of the cognitive ecosystem.

> **EGC - Extended Global Context**  
> **Desenvolvido por Felipe Marzochi**  
> **@MarzochiFelipe**  
> **https://github.com/Fmarzochi/EGC**  
> **Discord: https://discord.gg/AtazrtxJ**  
> **© Todos os direitos reservados**

---

## Table of Contents

- [Governance Philosophy](#governance-philosophy)
- [Quick Start](#quick-start)
- [Developer Certificate of Origin (DCO)](#developer-certificate-of-origin-dco)
- [CI Checks](#ci-checks)
- [Orchestrators & Runtime Core](#orchestrators--runtime-core)
- [Contributing Skills](#contributing-skills)
- [Skill Adaptation Policy](#skill-adaptation-policy)
- [Contributing Agents](#contributing-agents)
- [Contributing Hooks](#contributing-hooks)
- [Contributing Commands](#contributing-commands)
- [Contributing Translations](#contributing-translations)
- [Pull Request Process](#pull-request-process)

---

## Governance Philosophy

EGC operates under a philosophy of **Stability over Expansion** and **Passive Maintenance**.

1. **Runtime Hardening:** EGC is a production-grade orchestration engine. We prioritize making the existing system more resilient over adding unstructured novelty.
2. **Passive Maintenance:** EGC is designed to require minimal upkeep. Contributions must not introduce brittle dependencies, external APIs that frequently break, or obscure hacks.
3. **Cross-Platform Integrity:** EGC supports Linux, Windows, and macOS. Contributions, especially to install scripts and hooks, must validate safely across these environments without platform-specific hardcoding.
4. **Runtime Protection:** The core engine (Execution Queue, ModelResolver, JSON Registry) is locked down. Changes to the orchestration layer require exponentially higher validation standards than adding a new skill.

---

## Where to start

Not sure where to begin? Here are the best entry points:

**Fix a real bug (code):** Issues labeled [`good first issue`](https://github.com/Fmarzochi/EGC/issues?q=is%3Aopen+label%3A%22good+first+issue%22) are small, self-contained, and come with a suggested fix and the exact file and line range. Start here if you want to write code.

**Translate the README:** Open issues exist for [German](https://github.com/Fmarzochi/EGC/issues/486), [French](https://github.com/Fmarzochi/EGC/issues/480), [Japanese](https://github.com/Fmarzochi/EGC/issues/482), [Chinese Simplified](https://github.com/Fmarzochi/EGC/issues/483), [Russian](https://github.com/Fmarzochi/EGC/issues/487), [Italian](https://github.com/Fmarzochi/EGC/issues/481), [Turkish](https://github.com/Fmarzochi/EGC/issues/484), [Ukrainian](https://github.com/Fmarzochi/EGC/issues/479), and [Malay](https://github.com/Fmarzochi/EGC/issues/488). Translation is done on [Crowdin](https://crowdin.com/project/egc) -- no code required.

**Test on your platform:** If you are on [Windows](https://github.com/Fmarzochi/EGC/issues/476) or [macOS](https://github.com/Fmarzochi/EGC/issues/477), install EGC and report what works and what does not. No code required.

**Add an agent or skill:** Look at existing files in `agents/` and `skills/` for examples. The format is documented below and the CI validator will tell you exactly what is wrong if your file has a structural issue.

For all contributions, the two hard requirements are `git commit -s` (DCO) and signing the CLA when the bot asks. Both are explained in the sections below.

---

## Quick Start

```bash
# 1. Fork and clone the EGC OS
gh repo fork Fmarzochi/EGC --clone
cd EGC

# 2. Create a feature branch
git checkout -b feat/my-contribution

# 3. Add your contribution following the architectural standards below

# 4. Verify locally (all of these must pass before you open a PR)
npm ci
node tests/run-all.js              # full test suite (runs on Linux, macOS, Windows)
npm audit --audit-level=high       # must show 0 high/critical vulnerabilities

# 5. Submit PR (note: -s adds the required DCO sign-off to your commit)
git add . && git commit -s -m "feat: add my-feature" && git push -u origin feat/my-contribution
```

---

## Developer Certificate of Origin (DCO)

Every commit in your pull request **must** include a `Signed-off-by` line. This certifies that you wrote the code and have the right to contribute it under the project's MIT license. The `dco.yml` workflow checks every commit in every PR and blocks the merge if any commit is missing the signature.

**For new commits, always use the `-s` flag:**

```bash
git commit -s -m "feat: add my-feature"
```

This automatically appends the required line to your commit message:

```
Signed-off-by: Your Full Name <your@email.com>
```

**To sign an existing unsigned commit:**

```bash
git commit --amend -s
git push --force-with-lease
```

**To sign all commits in a branch at once:**

```bash
git rebase --signoff main
git push --force-with-lease
```

> The `Signed-off-by` line must use the same name and email as your Git identity (`git config user.name` and `git config user.email`).

---

## Contributor License Agreement (CLA)

Every contributor must sign the CLA once before their first PR can be merged.

**How to sign:** When you open your first PR, the CLA bot will post a comment. Reply with:

```
I have read the CLA Document and I hereby sign the CLA.
```

That is it. One comment, one time. Future PRs are merged without any extra steps.

Read the full agreement at [.github/CLA.md](CLA.md). It is short (4 clauses) and written in plain English.

---

## CI Checks

Every pull request runs the following automated checks. Your PR must pass all of them before it can be merged.

| Check | What it validates | How to pass |
|---|---|---|
| **CLA** | First-time contributors have signed the CLA | Post the sign comment when the bot asks |
| **DCO** | Every commit has `Signed-off-by` | Use `git commit -s` on every commit |
| **CI / test** | `node tests/run-all.js` on Linux, macOS, Windows with Node 20 and 22, using npm, yarn, and bun | Run `node tests/run-all.js` locally before opening a PR |
| **CI / lint** | ESLint on `scripts/` and `tests/`; markdownlint on all `.md` files in `agents/`, `skills/`, `commands/`, `rules/` | Run `npx markdownlint "agents/**/*.md"` if you added or edited Markdown files |
| **CI / validate** | Structure validators: agents, hooks, skills, commands, install manifests, rules, unicode safety | Run `node scripts/ci/validate-skills.js` (or the equivalent for your component type) |
| **CI / security** | `npm audit --audit-level=high` | Run `npm audit --audit-level=high` locally; do not introduce packages with known high or critical vulnerabilities |
| **Dependency Review** | Blocks dependencies with incompatible licenses or known CVEs | Check the license of any package you add |
| **SonarCloud** | Static analysis: code smells, bugs, security hotspots | Review the SonarCloud report linked in your PR |
| **CodeRabbit** | AI code review | Read and address CodeRabbit's findings in your PR comments |
| **PR Size** | Fails if your PR changes more than 150 code files | Keep PRs focused; split large changes into smaller ones |

### CI on fork pull requests

If this is your first contribution from a fork, GitHub requires a maintainer to approve the CI run by clicking **"Approve and run"** in the Actions tab. Your PR will show checks as "Waiting" until a maintainer approves. This is expected: do not close and reopen your PR. A maintainer will approve the run during review.

---

## Orchestrators & Runtime Core

While adding Agents and Skills is the most common contribution, EGC's true power lies in its **Runtime Ecosystem**: Orchestrators, the Execution Queue, and the Registry.

If you are proposing changes to `scripts/`, `src/llm/`, or the underlying orchestrator logic:
- **Execution Queue Stability:** Modifications must not introduce race conditions or break the deterministic sequencing of agent tasks.
- **Runtime-Map Integrity:** EGC uses a JSON registry (`registry/runtime-map.json`) to link the cognitive layer to the physical filesystem. Any new core capability must map correctly to the registry.
- **Registry Synchronization:** Ensure that the catalog and CI validators can still parse the registry after your modifications.
- **Orchestration Layer Modifications:** These are strictly reviewed. If you add a new orchestrator (e.g., a new DAG parser or parallel execution loop), it must include fallback safety mechanisms and graceful degradation if a task fails.

---

## Contributing Skills

Skills are standardized operating procedures that the EGC Runtime loads based on context.

### Directory Structure

```
skills/
└── your-skill-name/
    └── SKILL.md
```

### SKILL.md Template

```markdown
---
name: your-skill-name
description: Brief description used for auto-activation.
origin: EGC
---

# Your Skill Title

Brief overview of what this skill covers.

## When to Activate

Describe scenarios where the EGC orchestrator should load this skill into the context window.

## Core Concepts

Explain key patterns and guidelines.

## Code Examples

\`\`\`typescript
// Include practical, tested examples
function example() {
  // Well-commented code
}
\`\`\`

## Anti-Patterns

Show what NOT to do with examples.

## Best Practices

- Actionable guidelines
- Do's and don'ts
- Common pitfalls to avoid

## Related Skills

Link to complementary EGC skills (e.g., `related-skill-1`).
```

### Skill Categories

| Category | Purpose | Examples |
|----------|---------|----------|
| **Language Standards** | Idioms, conventions, best practices | `python-patterns`, `golang-patterns` |
| **Framework Patterns** | Framework-specific guidance | `django-patterns`, `nextjs-patterns` |
| **Workflow** | Step-by-step processes | `tdd-workflow`, `refactoring-workflow` |
| **Domain Knowledge** | Specialized domains | `security-review`, `api-design` |
| **Tool Integration** | Tool/library usage | `docker-patterns`, `supabase-patterns` |

### Skill Adaptation Policy

If porting an idea from another system:
- Copy the underlying logic, not the external product identity.
- Rename the skill when EGC materially changes or expands the surface.
- Prefer EGC-native rules and skills over unvetted third-party npm/pip dependencies.

### Skill Checklist

- [ ] Focused on one domain/technology.
- [ ] Includes "When to Activate" section.
- [ ] Includes practical, copy-pasteable code examples.
- [ ] Shows anti-patterns.
- [ ] Under 500 lines (800 max).
- [ ] Tested via the EGC CLI.
- [ ] No sensitive data (API keys, paths).

---

## Contributing Agents

Agents are specialized cognitive workers invoked by the EGC orchestration engine to handle specific tasks.

### File Location

```
agents/your-agent-name.md
```

### Agent Template

```markdown
---
name: your-agent-name
description: What this agent does and when the orchestrator should invoke it. Be specific!
tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]
model: claude-sonnet-4-6
stack: ["*"]
---

You are a [role] specialist operating within the EGC runtime.

## Your Role

- Primary responsibility
- Secondary responsibility
- What you DO NOT do (boundaries)

## Workflow

### Step 1: Understand
How you approach the task using EGC tools.

### Step 2: Execute
How you perform the work.

### Step 3: Verify
How you validate results before returning control to the orchestrator.

## Output Format

What you return to the runtime queue or user.
```

### Agent Fields

| Field | Description | Options |
|-------|-------------|---------|
| `name` | Lowercase, hyphenated | `code-reviewer` |
| `description` | Used for routing decisions | Be specific! |
| `tools` | Only what's needed | `Read`, `Write`, `Bash`, `Task` (for delegation) |
| `model` | Capability target | `claude-haiku-4-5` (fast), `claude-sonnet-4-6` (complex) |
| `stack` | Project types this agent targets | `["*"]` (all), `["python"]`, `["python", "django"]` |

---

## Contributing Hooks

Hooks are automatic interceptors triggered by lifecycle events within the EGC runtime.

### File Location

```
hooks/hooks.json
```

### Hook Types

| Type | Trigger | Use Case |
|------|---------|----------|
| `PreToolUse` | Before an agent tool executes | Validate, warn, or block destructive actions |
| `PostToolUse` | After a tool runs | Format code, audit outputs, notify systems |
| `SessionStart` | Session begins | Load project memory, initialize connections |
| `Stop` | Session ends | Cleanup artifacts, write session summaries |

### Hook Format

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "tool == \"Bash\" && tool_input.command matches \"rm -rf /\"",
        "hooks": [
          {
            "type": "command",
            "command": "echo '[EGC Hook] BLOCKED: Destructive command intercepted.' && exit 1"
          }
        ],
        "description": "Block dangerous rm commands at the runtime level"
      }
    ]
  }
}
```

### Hook Checklist

- [ ] Matcher is extremely specific.
- [ ] Includes clear error/info messages identifying it as an `[EGC Hook]`.
- [ ] Uses correct exit codes (`exit 1` strictly blocks execution).
- [ ] Tested extensively locally to ensure it doesn't break normal workflows.

---

## Contributing Commands

Commands are user-invoked macro actions initiated via `/command-name` in the CLI.

### File Location

```
commands/your-command.md
```

### Command Template

```markdown
---
description: Brief description shown in /help
---

# Command Name

## Purpose

What this macro accomplishes within the EGC ecosystem.

## Usage

\`\`\`
/your-command [args]
\`\`\`

## Workflow

1. Step one
2. Step two
3. Final step

## Output

Expected deterministic outcome.
```

---

## Contributing Translations

[![Crowdin](https://badges.crowdin.net/egc/localized.svg)](https://crowdin.com/project/egc)

EGC uses [Crowdin](https://crowdin.com/project/egc) for community translations. Translations are synced automatically via GitHub Actions.

### Rules

- **Never open a manual PR for translations.** A PR is created automatically when a language reaches 100%.
- **Never merge a translation PR if progress is below 100%.** The workflow badge and PR description show the current percentage.
- If your language shows less than 100%, keep translating in Crowdin. The PR will be opened when you finish.

### How to contribute as a translator

1. Go to [crowdin.com/project/egc](https://crowdin.com/project/egc)
2. Log in or create a free account
3. Select your language
4. Translate the strings
5. When you reach 100%, a PR is opened automatically in this repository

### Current translations

| Language | Progress | File |
|---|---|---|
| English | Source | [README.md](../README.md) |
| Español | 100% | [translations/es/README.md](../translations/es/README.md) |
| Português (Brasil) | 100% | [translations/pt/README.md](../translations/pt/README.md) |

---

## Contribuindo com Traducoes

[![Crowdin](https://badges.crowdin.net/egc/localized.svg)](https://crowdin.com/project/egc)

O EGC usa o [Crowdin](https://crowdin.com/project/egc) para traducoes feitas pela comunidade. As traducoes sao sincronizadas automaticamente via GitHub Actions.

### Regras

- **Nunca abra um PR manual de traducao.** Um PR e criado automaticamente quando um idioma atinge 100%.
- **Nunca faca merge de um PR de traducao com progresso abaixo de 100%.** O badge do workflow e a descricao do PR mostram a porcentagem atual.
- Se o seu idioma mostrar menos de 100%, continue traduzindo no Crowdin. O PR sera aberto quando voce terminar.

### Como contribuir como tradutor

1. Acesse [crowdin.com/project/egc](https://crowdin.com/project/egc)
2. Entre ou crie uma conta gratuita
3. Escolha o seu idioma
4. Traduza as strings
5. Ao atingir 100%, um PR e aberto automaticamente neste repositorio

### Traducoes disponíveis

| Idioma | Progresso | Arquivo |
|---|---|---|
| Ingles | Fonte | [README.md](../README.md) |
| Español | 100% | [translations/es/README.md](../translations/es/README.md) |
| Portugues do Brasil | 100% | [translations/pt/README.md](../translations/pt/README.md) |

---

## Pull Request Process

### 1. PR Title Format

Follow standard conventional commits, prefixed appropriately:

```
feat(runtime): optimize install adapter for Kiro
feat(mcp): extend egc-guardian validation rules
feat(skills): add rust-patterns skill
fix(hooks): resolve session-start hook on Windows
docs(governance): update EGC contribution guidelines
```

### 2. PR Description

```markdown
## Summary
What architectural gap this fills or what capability this adds to EGC.

## Component Type
- [ ] Core Engine / Orchestrator
- [ ] MCP Server (egc-guardian / egc-memory)
- [ ] Agent
- [ ] Skill
- [ ] Hook
- [ ] Command

## Validation
How you ensured this maintains Runtime Integrity and Cross-Platform stability.

## Checklist
- [ ] CLA signed (first contribution only - reply to the bot comment)
- [ ] All commits are signed off with `git commit -s` (required by DCO check)
- [ ] `node tests/run-all.js` passes locally with zero failures
- [ ] `npm audit --audit-level=high` shows no high or critical vulnerabilities
- [ ] Markdownlint passes on all `.md` files you created or modified (agents, skills, commands, rules)
- [ ] PR changes fewer than 150 code files
- [ ] Tested on Linux/macOS/Windows (if applicable to your change)
- [ ] Preserves EGC identity and formatting
- [ ] No sensitive data committed
- [ ] Doesn't break the `runtime-map.json` registry
```

### 3. Review Process

1. Changes touching the MCP servers or Runtime Core will undergo strict architecture review.
2. Skill and Agent additions are typically merged faster.
3. Maintainers will review, request adjustments, and merge once the system stability is assured.

---

---

## Dependencies

### How Dependencies Are Selected

EGC selects dependencies based on:

1. **Necessity**: a dependency is only added if it provides functionality that cannot reasonably be implemented in-project without significant maintenance cost
2. **License compatibility**: must be MIT, ISC, BSD, Apache-2.0, or equivalent permissive license
3. **Maintenance status**: preferred packages must have active maintenance and a responsive security process

### Obtaining Dependencies

Dependencies are obtained exclusively through npm. All dependencies are listed in `package.json` and locked in `package-lock.json`. To install:

```bash
npm ci
```

This installs the exact versions from the lock file, ensuring reproducible builds.

### Tracking Dependencies

- Dependabot is configured to automatically open PRs for outdated or vulnerable dependencies
- `npm audit` runs on every CI build and fails on high/critical severity findings
- The `dependency-review.yml` workflow blocks PRs that introduce new high-severity dependencies
- SCA policy details are documented at `docs/security/SCA-POLICY.md`

---

## Build Instructions

### Requirements

- Node.js 20 or later
- npm (bundled with Node.js) or yarn or bun

### Building

```bash
# Install dependencies
npm ci

# Build MCP servers (TypeScript -> JavaScript)
npm run build

# Run tests
node tests/run-all.js
```

The MCP servers (`egc-guardian`, `egc-memory`) are TypeScript projects compiled with `tsc`. Build output goes to `dist/` inside each server directory.

See the [installation guide](docs/installation/) for platform-specific instructions.

---

**Thank you for elevating AI orchestration from chatboxes to engineering systems.**