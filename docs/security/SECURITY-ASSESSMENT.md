# Security Assessment: Extended Global Context (EGC)

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
| Git history | State files carry distilled project decisions; they must never reach a public commit. Enforced by a git clean filter, a pre-commit hook, and a CI tree guard (v1.1.12-v1.1.13). |

## Threat Identification

### High Likelihood / High Impact

| Threat | Mitigation |
|--------|-----------|
| Malicious dependency supply chain | Pinned dependencies via package-lock.json; Dependabot alerts; `dependency-review.yml` blocks high-severity additions; `npm audit` in CI |
| Command injection via MCP inputs | `egc-guardian` validates all tool calls via `validate_command` before execution; `execSync` replaced with `spawnSync` plus argv tokenization, removing a shell-injection surface (v1.1.8, #690) |
| Destructive CLI commands executed by the AI | `docker system prune`, `docker rm/rmi`, `docker run --privileged` or host mounts, `gh repo delete`, `gh api -X DELETE`, and `prisma migrate reset` / `--force-reset` / `db execute` return a hard DANGEROUS verdict instead of an advisory warning (v1.1.16, #1041). An absolute-path bypass (`/bin/rm`, `/usr/bin/mv`) was closed the same release (#1012). |
| Validator itself failing silently | The bash hook dispatcher used to fail open on its own internal errors, silently disabling every guard (Guardian validate, GateGuard) for that command. It now fails closed instead (v1.1.16, #1019), the most critical finding of that release's security audit. |
| Credential leakage in session logs | Session transcript sanitization removes sensitive env vars from log output; `egc-guardian` blocks writes to the specific credential files each AI tool stores rather than whole config directories (v1.1.8, #691, replacing an earlier whole-directory block that broke legitimate functionality without adding real security) |

### Medium Likelihood / Medium Impact

| Threat | Mitigation |
|--------|-----------|
| Unauthorized filesystem access | MCP server runs in user context; no privilege escalation |
| State file tampering or theft | State files under `~/.egc/state/` are encrypted at rest with AES-256-GCM (v1.1.6, #627) and carry a per-file HMAC-SHA256 integrity check that `get_state` verifies on read (v1.1.6, #625). They are not plain text and do contain security-sensitive project context, which is why encryption was added. |
| Project memory leaking into a public commit | Enforced in three independent layers: a git clean filter configured by `egc init` that stages a zeroed blob even when hooks are bypassed (v1.1.13, #863), a tracked pre-commit hook, and a CI tree guard (v1.1.12, #856) |
| Prompt injection via transcript | AI tool is responsible for prompt handling; EGC provides raw session data only. `session_events` payloads from other sessions on the session bus are explicitly documented as untrusted data, never instructions to execute blindly. |
| TOCTOU races on files shared by concurrent EGC processes | Encryption key generation is now atomic (write-to-temp plus `fs.linkSync`), closing a race where a second process starting concurrently could read a partially-written key or silently generate a discarded one (v1.1.9, #696). A concurrent-access regression test is now a contribution requirement for any change touching a shared file under `~/.egc/` (v1.1.9, #697). |
| `auto_learn` writing outside the project sandbox | `target_file` is validated against protected paths and must stay inside the project root (v1.1.16, #1009); `project_path` is resolved with `realpathSync` and checked before use (v1.1.8, #690) |
| Guardian command-validator argument-parsing bypasses | Closed in v1.1.14 (#882); `core.hooksPath` no-verify bypass matched case-insensitively (v1.1.16, #1013) |

### Low Likelihood

| Threat | Mitigation |
|--------|-----------|
| Denial of service via large transcript | 1MB stdin cap in session hooks |
| Denial of service via oversized dashboard event payload | `POST /event` body capped at 256 KB (v1.1.6, #551) |
| Denial of service via request flooding | `egc-guardian` scoped rate limiter per project path (v1.1.6, #544) |
| Path traversal in dashboard static file server | Guard against `../` traversal (v1.1.6, #537) |
| Malformed JSON crashing hook | Try/catch in all JSONL parsers; graceful exit on error |
| CI/CD injection via untrusted PR content | `republish.yml`'s version input is validated instead of interpolated directly into a shell command (v1.1.16, #1027) |
| Secrets leaking through provider SDK error messages | Redacted in mapped SDK errors, including Google API keys (v1.1.14, #883) |
| Container escape / build-toolchain exposure in the shipped Docker image | Non-root user via multi-stage build; `.dockerignore` keeps `.git`, `.env`, and `node_modules` out of the build context (v1.1.16, #1036, #1028) |

## Known Limitations

- EGC is a local-only tool; it has no server component, no authentication, and no network services.
- The security posture depends on the security of the host machine and the AI tool integrations.
- Prompt injection from external content (e.g., malicious files read by the AI) is primarily an AI-tool-level concern. Guardian exposes a heuristic scanner, `validate_content` (also reachable via the `guardian-cli content` mode for harnesses without the MCP server running), that flags known injection patterns -- instruction-override phrasing, fake `[SYSTEM]`/`<system>` tags, persona-hijack attempts, exfiltration directives, spoofed chat-template control tokens, directives hidden in HTML comments, and zero-width-character clustering -- in content the AI is about to trust. This is regex pattern-matching, not semantic understanding: it will miss novel or obfuscated payloads, and it is advisory-only (it never blocks, only flags). A `PostToolUse` hook (`post:webfetch:injection-scan`) now runs it automatically on every `WebFetch` result, so remote page content is scanned without the AI having to invoke anything. Content that reaches the AI through other paths (files read via `Read`/`Grep`, PR diffs, MCP tool responses) is not auto-scanned today; a caller has to invoke `validate_content` manually for those.
- Guardian validation depends on the harness actually invoking the registered hooks. Amazon Q, Goose, and OpenHands (#1092) and Qwen Code (#1080) all have real Guardian hook wiring. Roo Code is the one exception: it has no external hook API (confirmed against its own docs and an open upstream feature request), so it gets a native `roo-cline.deniedCommands` seed instead of a Guardian adapter, a real but partial mitigation covering only the unconditionally-dangerous base commands by prefix match, not context-aware command-level enforcement.

## Assessment Date

2026-06-04 (initial). Updated 2026-07-27 to reflect security work through v1.1.16: destructive-CLI hard blocks, the dispatcher fail-open-to-fail-closed fix, commit-privacy enforcement, state encryption and integrity, and the TOCTOU/concurrent-access fixes. This is a mitigation-tracking update against the same threat categories, not a new independent audit; a fresh third-party review remains a v2.0.0 goal (see `docs/spec/README.md`).
