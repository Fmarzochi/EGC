# Threat Model: Extended Global Context (EGC)

## System Overview

EGC is a local-first AI memory and orchestration runtime. It has no network services, no authentication surface, and no multi-user access model. The attack surface is limited to:

1. The npm package and its dependencies
2. The MCP servers running as local stdio processes
3. The GitHub Actions CI/CD pipeline
4. Session hooks that process transcript data
5. The 23 supported AI harnesses' own config/instruction files, which EGC writes to (see `docs/spec/integration-tiers.md`)

## Actors

| Actor | Trust Level | Description |
|-------|-------------|-------------|
| Local user | Fully trusted | Runs EGC on their own machine |
| Contributor | Partially trusted | Submits PRs; cannot merge without review |
| Dependency author | Untrusted | Third-party npm packages |
| AI tool (Claude Code, etc.) | Trusted at runtime | Calls MCP tools; runs in same user context |
| GitHub Actions runner | Trusted | Ephemeral sandboxed environment |
| PR author (fork) | Untrusted | Code from forks does not access secrets |
| Peer session on the session bus | Partially trusted | Can send events to other live sessions on the same project; payloads are treated as untrusted data by the receiver, never executed as instructions |

## Attack Surfaces and Mitigations

### 1. Dependency Injection / Supply Chain

**Threat:** A malicious or compromised npm package is introduced.

**Mitigations:**
- All dependencies are locked via `package-lock.json`, across the root and both MCP server subpackages
- Dependabot monitors for vulnerability alerts
- `dependency-review.yml` blocks PRs that introduce high-severity dependencies
- CI runs `npm audit` on every push
- OpenSSF Scorecard tracked publicly; pinned-dependency and branch-protection findings are treated as real work items, not just a badge (e.g. the `npm ci` / install-script finding that shaped #986)

### 2. Command Injection and Destructive Commands via MCP Inputs

**Threat:** A malicious or simply mistaken AI-generated tool call attempts to execute arbitrary or destructive shell commands.

**Mitigations:**
- `egc-guardian` validates all tool calls before execution via `validate_command`
- Shell commands are constructed from whitelisted patterns, not raw string interpolation; `execSync` was replaced with `spawnSync` plus argv tokenization (v1.1.8, #690)
- The guardian returns a block decision before any dangerous command runs
- Destructive docker/gh/prisma variants (`docker system prune`, `docker rm/rmi`, `docker run --privileged` or host mounts, `gh repo delete`, `gh api -X DELETE`, `prisma migrate reset`/`--force-reset`/`db execute`) return a hard DANGEROUS verdict instead of an advisory warning (v1.1.16, #1041)
- An absolute-path bypass (`/bin/rm`, `/usr/bin/mv` slipping through as an allowlist miss) was closed in the same release (#1012)
- The bash hook dispatcher fails closed on its own internal errors instead of silently disabling every guard for that command, the most critical finding of the v1.1.16 security audit (#1019)

### 3. Credential Leakage in Logs and Writes

**Threat:** Sensitive values (API keys, session tokens) appear in session transcript files, or the AI writes to a credential file directly.

**Mitigations:**
- Session hook sanitizes transcript content before writing to disk
- Environment variable names (`GEMINI_TRANSCRIPT_PATH`, `EGC_SESSION_ID`) are replaced with placeholders in log output
- State files at `~/.egc/state/` contain only structured metadata, not raw transcripts, and are themselves encrypted at rest (AES-256-GCM, v1.1.6, #627) with an HMAC-SHA256 integrity check (#625)
- `egc-guardian` blocks writes to the specific credential files each AI tool stores (OAuth tokens, session files, API keys) rather than whole config directories, a change made after the previous whole-directory block was found to break legitimate functionality without adding real security (v1.1.8, #691)
- Secrets are redacted in mapped provider SDK errors, including Google API keys (v1.1.14, #883)

### 4. Project Memory Leaking into Version Control

**Threat:** The populated propagation files EGC writes to every AI tool's instruction file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Cursor rules, etc.) get committed with real project decisions in them.

**Mitigations:**
- A git clean filter, configured locally by `egc init`, stages a zeroed blob for the propagation files even when local hooks are bypassed (v1.1.13, #863)
- A tracked pre-commit hook and a CI tree guard provide two independent layers on top of the filter (v1.1.12, #856)
- The public baseline of every propagation file ships zeroed; the working tree keeps the populated memory locally only

### 5. CI/CD Pipeline Compromise

**Threat:** A malicious PR triggers a workflow that accesses secrets or modifies the release.

**Mitigations:**
- `pull_request` events from forks do not have access to repository secrets
- `pull_request_target` is not used in any workflow (avoids the common privilege escalation pattern)
- Workflows use minimal permissions (`permissions: contents: read` by default)
- Release workflow only triggers on version tags pushed by the maintainer
- All third-party actions are pinned to specific commit SHAs
- CodeRabbit reviews contributor PRs automatically and skips the maintainer's own, retiring the older manual first-time-contributor gate workflows (v1.1.16, #997)

### 6. Untrusted Input in CI Pipelines

**Threat:** Branch names, commit messages, or PR metadata are interpolated unsafely in shell commands.

**Mitigations:**
- All GitHub context variables that are used in `run:` steps are passed through `env:` and not directly interpolated in shell strings
- The release workflow validates the tag format with a regex before using it
- `workflow_dispatch` does not accept external user inputs
- `republish.yml`'s version input is validated instead of interpolated directly into a shell command (v1.1.16, #1027)

### 7. Concurrent-Process Races on Shared Local State

**Threat:** Two EGC processes (e.g. two parallel AI sessions) read or write the same file under `~/.egc/` at the same time, producing a corrupted key, a lost write, or a silently discarded value.

**Mitigations:**
- Encryption key publication is atomic (write-to-temp plus `fs.linkSync`), closing a TOCTOU race where a racing reader used to be able to see a partial write or generate its own discarded key (v1.1.9, #696)
- Multi-session SQLite write arbitration hardened with equal jitter and deeper retries (v1.1.12, #853)
- The session bus uses fail-fast cooperative locks (`claim_path`/`release_path`): a refused claim means another live session holds it, and the caller is expected to coordinate rather than retry in a loop
- Any change touching a file shared across concurrent EGC processes now requires a concurrent-access regression test before merge, a contribution requirement added directly because of the encryption-key race above (v1.1.9, #697)

### 8. Container Image Attack Surface

**Threat:** The published Docker image ships a larger attack surface than necessary (build toolchain, root user, extraneous files).

**Mitigations:**
- Images run as a non-root user via a multi-stage build that keeps the build toolchain out of the final image (v1.1.16, #1036)
- `.dockerignore` keeps `.git`, `.env`, and `node_modules` out of the build context (v1.1.16, #1028)

## Critical Code Paths

| Path | Risk | Protection |
|------|------|-----------|
| `mcp/servers/egc-guardian/src/validator.ts` | High: gates all shell execution and file writes | Reviewed on every change; blocked by branch protection; the destructive-CLI test suite alone is 64 cases |
| `mcp/servers/egc-guardian/src/index.ts` (bash hook dispatcher entry) | High: an error here used to fail open for every guard | Fails closed since v1.1.16 (#1019); regression-tested |
| `install.sh` / `install.ps1` | Medium: modifies global AI tool configs across 23 harnesses | Verified in CI across Linux, macOS, Windows (full matrix: Node 20/22 x npm/yarn/bun) |
| `scripts/hooks/session-end.js` | Medium: reads transcript, writes to disk | Bounded stdin (1MB cap); structured error handling |
| `mcp/servers/egc-memory/src/index.ts` | Medium: reads/writes encrypted state files, arbitrates concurrent writes | No shell execution; pure file I/O; concurrent-access regression tests required by policy |

## Residual Risk

EGC is a developer tool that runs with full local-user permissions by design. A compromised host machine, compromised AI tool, or compromised npm package could affect EGC. These risks are outside EGC's control and mitigated by the host environment. A harness that does not support hook wiring (several Tier 1 discoverability-only adapters: Goose, OpenHands, Amazon Q, Roo Code, Qwen Code) receives memory and skills but not command-level Guardian enforcement, since there is no hook API to attach to.

## Review Date

2026-06-04: Felipe Marzochi (initial). 2026-07-27: updated to reflect the security work shipped in v1.1.8 through v1.1.16 (destructive-CLI hard blocks, fail-closed dispatcher, commit-privacy enforcement, encryption/integrity, concurrent-access hardening). A fresh independent third-party review remains a v2.0.0 goal (see `docs/spec/README.md`).
