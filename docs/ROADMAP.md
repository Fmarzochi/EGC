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

## v1.2.0: Stability

Fix what is broken before growing further.

- Fix dashboard adapters: CodeBuddy noisy events (#506), VS Code wrong Copilot log (#504), Aider stops after log rotation (#503), POST /event body size cap (#499)
- True automatic session save: eliminate dependency on AI following a prompt to call `update_state`
- Validated Windows install experience with documented troubleshooting
- Contributor pipeline: structured `good first issue` backlog, "Where to start" in CONTRIBUTING.md
- `egc install --target <tool>`: create context stubs for individual tools on first install

## v1.3.0: Growth

- Community translations: German, French, Japanese, Chinese Simplified, Russian, Italian, Turkish, Ukrainian, Malay
- Plugin system for community-contributed agents and skills
- Per-project skill profiles and overrides
- `egc install --target <tool>`: expanded target coverage

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
