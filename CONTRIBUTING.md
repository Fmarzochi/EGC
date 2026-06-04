# Contributing to Everything Gemini Code (EGC)

Welcome to the engineering governance guide for **Everything Gemini Code (EGC)**. This is not just a collection of prompts or scripts; it is a cross-platform AI operating system and runtime orchestration fabric.

Because EGC operates as a structured engineering platform, contributions must align with our core architecture, ensuring the stability, observability, and deterministic execution of the cognitive ecosystem.

> **EGC — Everything Gemini Code**  
> **Desenvolvido por Felipe Marzochi**  
> **@MarzochiFelipe**  
> **https://github.com/Fmarzochi/everything-gemini**  
> **© Todos os direitos reservados**

---

## Table of Contents

- [Governance Philosophy](#governance-philosophy)
- [Quick Start](#quick-start)
- [Orchestrators & Runtime Core](#orchestrators--runtime-core)
- [Contributing Skills](#contributing-skills)
- [Skill Adaptation Policy](#skill-adaptation-policy)
- [Contributing Agents](#contributing-agents)
- [Contributing Hooks](#contributing-hooks)
- [Contributing Commands](#contributing-commands)
- [Pull Request Process](#pull-request-process)

---

## Governance Philosophy

EGC operates under a philosophy of **Stability over Expansion** and **Passive Maintenance**.

1. **Runtime Hardening:** EGC is a production-grade orchestration engine. We prioritize making the existing system more resilient over adding unstructured novelty.
2. **Passive Maintenance:** EGC is designed to require minimal upkeep. Contributions must not introduce brittle dependencies, external APIs that frequently break, or obscure hacks.
3. **Cross-Platform Integrity:** EGC supports Linux, Windows, and macOS. Contributions, especially to install scripts and hooks, must validate safely across these environments without platform-specific hardcoding.
4. **Runtime Protection:** The core engine (Execution Queue, ModelResolver, JSON Registry) is locked down. Changes to the orchestration layer require exponentially higher validation standards than adding a new skill.

---

## Quick Start

```bash
# 1. Fork and clone the EGC OS
gh repo fork Fmarzochi/everything-gemini --clone
cd everything-gemini

# 2. Create a feature branch
git checkout -b feat/my-contribution

# 3. Add your contribution following the architectural standards below

# 4. Verify locally
sh install.sh && egc doctor

# 5. Submit PR
git add . && git commit -m "feat: add my-feature" && git push -u origin feat/my-contribution
```

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
model: gemini-2.5-pro
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
| `model` | Capability target | `gemini-1.5-flash` (fast), `gemini-2.5-pro` (complex) |

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
- [ ] Tested on Linux/macOS/Windows (if applicable)
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

1. **Necessity** — a dependency is only added if it provides functionality that cannot reasonably be implemented in-project without significant maintenance cost
2. **License compatibility** — must be MIT, ISC, BSD, Apache-2.0, or equivalent permissive license
3. **Maintenance status** — preferred packages must have active maintenance and a responsive security process

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

- Node.js 18 or later
- npm (bundled with Node.js) or yarn or bun

### Building

```bash
# Install dependencies
npm ci

# Build MCP servers (TypeScript -> JavaScript)
npm run build

# Run tests
npm test
```

The MCP servers (`egc-guardian`, `egc-memory`) are TypeScript projects compiled with `tsc`. Build output goes to `dist/` inside each server directory.

See the [installation guide](docs/installation/) for platform-specific instructions.

---

**Thank you for elevating AI orchestration from chatboxes to engineering systems.**