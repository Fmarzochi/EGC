# Threat Model — Extended Global Context (EGC)

## System Overview

EGC is a local-first AI memory and orchestration runtime. It has no network services, no authentication surface, and no multi-user access model. The attack surface is limited to:

1. The npm package and its dependencies
2. The MCP servers running as local stdio processes
3. The GitHub Actions CI/CD pipeline
4. Session hooks that process transcript data

## Actors

| Actor | Trust Level | Description |
|-------|-------------|-------------|
| Local user | Fully trusted | Runs EGC on their own machine |
| Contributor | Partially trusted | Submits PRs; cannot merge without review |
| Dependency author | Untrusted | Third-party npm packages |
| AI tool (Claude Code, etc.) | Trusted at runtime | Calls MCP tools; runs in same user context |
| GitHub Actions runner | Trusted | Ephemeral sandboxed environment |
| PR author (fork) | Untrusted | Code from forks does not access secrets |

## Attack Surfaces and Mitigations

### 1. Dependency Injection / Supply Chain

**Threat:** A malicious or compromised npm package is introduced.

**Mitigations:**
- All dependencies are locked via `package-lock.json`
- Dependabot monitors for vulnerability alerts
- `dependency-review.yml` blocks PRs that introduce high-severity dependencies
- CI runs `npm audit` on every push

### 2. Command Injection via MCP Inputs

**Threat:** A malicious AI-generated MCP call attempts to execute arbitrary shell commands.

**Mitigations:**
- `egc-guardian` validates all tool calls before execution via `validate_command`
- Shell commands are constructed from whitelisted patterns, not raw string interpolation
- The guardian returns a block decision before any dangerous command runs

### 3. Credential Leakage in Logs

**Threat:** Sensitive values (API keys, session tokens) appear in session transcript files.

**Mitigations:**
- Session hook sanitizes transcript content before writing to disk
- Environment variable names (`GEMINI_TRANSCRIPT_PATH`, `EGC_SESSION_ID`) are replaced with placeholders in log output
- State files at `~/.egc/state/` contain only structured metadata, not raw transcripts

### 4. CI/CD Pipeline Compromise

**Threat:** A malicious PR triggers a workflow that accesses secrets or modifies the release.

**Mitigations:**
- `pull_request` events from forks do not have access to repository secrets
- `pull_request_target` is not used in any workflow (avoids the common privilege escalation pattern)
- Workflows use minimal permissions (`permissions: contents: read` by default)
- Release workflow only triggers on version tags pushed by the maintainer
- All third-party actions are pinned to specific commit SHAs

### 5. Untrusted Input in CI Pipelines

**Threat:** Branch names, commit messages, or PR metadata are interpolated unsafely in shell commands.

**Mitigations:**
- All GitHub context variables that are used in `run:` steps are passed through `env:` and not directly interpolated in shell strings
- The release workflow validates the tag format with a regex before using it
- `workflow_dispatch` does not accept external user inputs

## Critical Code Paths

| Path | Risk | Protection |
|------|------|-----------|
| `scripts/egc-guardian/src/validate_command.ts` | High — gates all shell execution | Reviewed on every change; blocked by branch protection |
| `install.sh` / `install.ps1` | Medium — modifies global AI tool configs | Verified in CI across Linux, macOS, Windows |
| `scripts/hooks/session-end.js` | Medium — reads transcript, writes to disk | Bounded stdin (1MB cap); structured error handling |
| `mcp/servers/egc-memory/` | Low — reads/writes state files only | No shell execution; pure file I/O |

## Residual Risk

EGC is a developer tool that runs with full local-user permissions by design. A compromised host machine, compromised AI tool, or compromised npm package could affect EGC. These risks are outside EGC's control and mitigated by the host environment.

## Review Date

2026-06-04 — Felipe Marzochi
