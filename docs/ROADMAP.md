# EGC Roadmap

This document describes the planned development direction for EGC (Extended Global Context).

## v1.1.2: Bidirectional Sync (Released 2026-06-20)

- `egc watch`: bidirectional sync daemon - edits in any tool config file propagate to all others and back to `~/.egc/state/` automatically (issues #302, #303)
- `update_state` now propagates context to 11 supported tool config files in one call (issue #313)
- Guardian pipeline: CacheAligner, ContentRouter, SmartCrusher, Headroom Phase 2 wired into `reduce_context`
- `sql.js` replaces `better-sqlite3`: pure-JavaScript/WebAssembly SQLite, no native compilation required
- `auto_learn`: new `egc-guardian` tool that mines session failures and writes actionable lessons automatically
- Stack briefing: session start now detects the project stack and emits a briefing with relevant agents

## v1.1.1: BM25 Search and Bug Fixes (Released 2026-06-19)

- `lesson_recall` upgraded to BM25 full-text search via FTS5 virtual table
- Fixed state DB path resolution across all harnesses
- Fixed hook commands to use `process.execPath` for reliable PATH resolution
- Added 7 OpenRouter model mappings (community contribution)

## v1.1.0: Memory Expansion (Released 2026-06-13)

- `working_memory`: transient key-value store with TTL (issue #138)
- `lessons`: cross-session knowledge with confidence decay (issue #140)
- `detect_patterns`: behavioral analysis from hook events (issue #141)
- `compress_observations`: rule-based observation compression (issue #142)
- `search_history`: BM25 full-text search over decisions (issue #139)
- Branch-aware project state: `get_state`/`update_state` scope per git branch (issue #137)
- State consolidation pipeline on each `update_state` call (issue #143)
- SessionStart hook runs idempotently across harness reinstalls

## v1.1.3 -- v1.1.6: Stability (Released 2026-07)

What shipped in the 1.1.x patch series:

- EGC Dashboard: real-time mission control at `localhost:7890` with live tool calls, token usage, provider comparison, and session export to CSV/JSON
- IDE hook emitters: Cursor, Kiro, OpenCode, CodeBuddy now emit events to the dashboard in real time
- Guardian Protocol deployed to all install targets: `orchestrate_task`, `validate_command`, `validate_write`, `auto_learn` ship by default
- Hook wiring fix: all four Claude Code hooks (SessionStart, Stop, UserPromptSubmit, PreToolUse) now correctly registered after `egc install`
- Continue.dev MCP registration (#564)
- Security batch: audit.log chmod 600, path traversal guard, scoped rate limiter, POST /event body cap, XSS escaping
- Community translations: Korean, Russian (7 languages total)
- 14 supported AI coding tools

## v1.2.0: Ecosystem

Expand what EGC can do through community-driven features:

- `egc replay`: session playback with timeline scrubbing -- review any past session event by event (#598)
- Budget guardian: per-session token and cost limits enforced at the PreToolUse hook (#599)
- Plugin registry: `egc plugin install <name>` -- community skill/agent packs via npm (#600)
- Team memory: sync lessons and decisions across teammates via git or S3 (#601)
- Native IDE integrations: Zed, Amp, or Windsurf (#602, good first issue)
- Validated Windows install experience with documented troubleshooting

## v1.3.0: Growth

- Plugin registry: community-published agent and skill packs installable via npm
- Community translations: German, French, Japanese, Chinese Simplified, Italian, Turkish, Ukrainian, Malay
- Per-project skill profiles and overrides

## v2.0.0: Teams

- Shared state between team members (multi-user installations)
- Team and organization-level installations
- Cross-project memory federation
- Stable MCP server API with versioned interfaces
- egc-guardian and egc-memory promoted to GA

## v3.0.0: Enterprise

- Formal security review by an independent party
- SBOM (Software Bill of Materials) generation
- Assurance case documenting security properties
- Contribution from at least two active maintainers (bus factor >= 2)

## Non-Goals

- EGC does not aim to replace AI providers: it augments them
- EGC does not store or transmit user code to any third party
- EGC does not require cloud connectivity for local installations
