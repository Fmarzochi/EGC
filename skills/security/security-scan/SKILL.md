---
name: security-scan
description: Scan the configuration of an AI coding tool (Claude Code, Gemini, Codex, OpenCode) for security vulnerabilities and misconfigurations with the built-in egc harness-audit and the Guardian, plus a review checklist for permissions, hooks, MCP registrations, instructions and agents. Installs nothing beyond EGC.
origin: EGC
---

# Security Scan Skill

Audit the configuration of an AI coding tool for security issues with what EGC already ships: the deterministic harness audit (`egc harness-audit`) for the scorecard, the Guardian MCP server for every file you then write, and a review checklist for the surfaces no scanner reads for you. Nothing else is installed: a scan that begins with `npx` of a package nobody vetted is itself a supply-chain risk.

## When to Activate

- New project with an AI coding tool
- Changed settings.json, CLAUDE.md or an MCP config
- Before committing config changes
- Onboarding to a repo with tool configs
- Periodic security hygiene

## Prerequisites

EGC installed (`npm install -g @egchq/egc`): the harness audit and the Guardian come with it. Nothing else.

## Usage

### Deterministic scorecard

```bash
# The current project; EGC repository mode or consumer-project mode is detected
egc harness-audit

# One scope, machine-readable
egc harness-audit hooks --format json

# Another checkout
egc harness-audit repo --root /path/to/project
```

The audit scores tool coverage, context strategy, quality gates, memory, evaluation, security guardrails and cost, and in a consumer project also the security policy, the secret hygiene of the config and the guardrails of the hooks. Read the security lines first: `checks[]` names each check with its file and whether it passed, and `top_actions` carries the fix for the three biggest gaps.

### Review by hand

The audit says what is missing, not what a file says. Open each surface and apply its check:

| Surface | Check |
|---|---|
| `CLAUDE.md`, `GEMINI.md`, `AGENTS.md` | hardcoded secrets, instructions that run commands without asking, prompt injection patterns |
| `settings.json` | allow lists broader than the work needs, no deny list, bypass flags |
| `.mcp.json`, `opencode.json`, other MCP configs | servers with shell or filesystem reach, remote transports, unpinned `npx`, secrets in `env` |
| `hooks/` and the hook entries of the settings | command injection through interpolation, data leaving the machine, errors silenced |
| `agents/*.md` | unrestricted tool access, prompts that handle untrusted content without defenses, no model named |

### Fixing what you find

Fix by hand, one surface at a time. With the Guardian registered in your tool (`egc init` or `egc install` does that; a global `npm install` alone does not), it judges every Write and Edit and refuses the protected paths (keys, credentials, the settings of the tool itself). Re-run `egc harness-audit` afterwards and compare the score.

### CI

```bash
egc harness-audit repo --format json > harness-audit.json
node -e "const r = require('./harness-audit.json'); process.exit(r.overall_score / r.max_score >= 0.75 ? 0 : 1)"
```

The audit exits 0 even when checks fail, so the second line is what fails the job: here under 75 percent of the points, with the Node every runner already has. `checks[]` names each check with its file and whether it passed; `top_actions` carries the fix for up to three failed checks.

## Severity Levels

The score below is `overall_score` as a percentage of `max_score`; the raw points depend on the scope (the repo scope has 70, so 63 of 70 is 90).

| Grade | Score | Meaning |
|-------|-------|---------|
| A | 90-100 | Secure configuration |
| B | 75-89 | Minor issues |
| C | 60-74 | Needs attention |
| D | 40-59 | Significant risks |
| F | 0-39 | Critical vulnerabilities |

## Interpreting Results

### Critical Findings (fix immediately)
- Hardcoded API keys or tokens in config files
- `Bash(*)` in the allow list (unrestricted shell access)
- Command injection in hooks via `${file}` interpolation
- Shell-running MCP servers

### High Findings (fix before production)
- Auto-run instructions in GEMINI.md (prompt injection vector)
- Missing deny lists in permissions
- Agents with unnecessary Bash access

### Medium Findings (recommended)
- Silent error suppression in hooks (`2>/dev/null`, `|| true`)
- Missing PreToolUse security hooks
- `npx -y` auto-install in MCP server configs

### Info Findings (awareness)
- Missing descriptions on MCP servers
- Prohibitive instructions correctly flagged as good practice

## Links

- Command: `commands/security-scan.md`
- Agent: `agents/security-reviewer.md`
- Audit engine: `scripts/harness-audit.js`
