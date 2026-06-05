# Security Assessment — Extended Global Context (EGC)

## Scope

This assessment covers the EGC runtime and its primary components:

- MCP servers: `egc-guardian`, `egc-memory`
- Installation scripts: `install.sh`, `install.ps1`
- Hook scripts: `scripts/hooks/`
- CLI entry points: `scripts/egc.js`, `scripts/egc-doctor.js`

## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Local filesystem | EGC reads and writes state files at `~/.egc/`. Access is local-user-only. |
| AI tool sockets | MCP servers communicate with AI tools via stdio or named sockets. No network exposure. |
| External dependencies | npm packages. Pinned via `package-lock.json`, audited via Dependabot. |
| GitHub Actions | CI/CD runs in ephemeral sandboxes with minimal permissions. |

## Threat Identification

### High Likelihood / High Impact

| Threat | Mitigation |
|--------|-----------|
| Malicious dependency supply chain | Pinned dependencies via package-lock.json; Dependabot alerts; npm audit in CI |
| Command injection via MCP inputs | `egc-guardian` validates all tool calls via `validate_command` before execution |
| Credential leakage in session logs | Session transcript sanitization removes sensitive env vars from log output |

### Medium Likelihood / Medium Impact

| Threat | Mitigation |
|--------|-----------|
| Unauthorized filesystem access | MCP server runs in user context; no privilege escalation |
| State file tampering | State files at `~/.egc/` are plain text; no security-sensitive data stored |
| Prompt injection via transcript | AI tool is responsible for prompt handling; EGC provides raw session data only |

### Low Likelihood

| Threat | Mitigation |
|--------|-----------|
| Denial of service via large transcript | 1MB stdin cap in session hooks |
| Malformed JSON crashing hook | Try/catch in all JSONL parsers; graceful exit on error |

## Known Limitations

- EGC is a local-only tool; it has no server component, no authentication, and no network services.
- The security posture depends on the security of the host machine and the AI tool integrations.
- Prompt injection from external content (e.g., malicious files read by the AI) is an AI-tool-level concern, not addressable at the EGC layer.

## Assessment Date

2026-06-04
