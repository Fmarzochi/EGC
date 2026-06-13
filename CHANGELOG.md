# Changelog

All notable changes to EGC are documented here.

## [1.1.0] - Unreleased

### New Tools

- **`detect_patterns`** - Analyzes runtime events from the state-store database to surface repeated commands and recurring errors across sessions. Helps identify automation candidates and structural issues that persist between conversations.

- **`working_memory`** - Stores transient context within a session with configurable TTL. Entries expire automatically so the memory store does not accumulate stale data across sessions. Exposed as `set_working_memory`, `get_working_memory`, and `delete_working_memory`.

- **`lessons`** - Records cross-session knowledge with confidence decay. Each lesson tracks how many times it was reinforced and when it was last seen; confidence degrades over time so stale lessons surface for review rather than being applied forever. Exposed as `add_lesson`, `list_lessons`, and `forget_lesson`.

- **`search_history`** - Full-text search over stored observations using FTS5 with BM25 ranking. Returns results ordered by relevance rather than recency.

### Memory Improvements

- **Branch-aware project state** - `get_state` and `update_state` scope memory per git branch. Switching branches restores the context for that branch automatically.

- **State consolidation pipeline** - A rule-based layering pipeline compresses and consolidates observations on each `update_state` call, keeping the memory store compact without losing important signals.

- **Deterministic SessionStart hook** - The SessionStart hook that writes context into the active harness settings file now runs idempotently. Re-running install or switching adapters does not duplicate entries.

### Infrastructure

- Upgraded CI matrix to Node 20/22/24; dropped Node 18 (EOL).
- Added Windows bun and yarn test jobs.
- SonarCloud AutoScan enabled; all Reliability D and Security Hotspot issues resolved.
- CodeQL Advanced scanning added.
- Dependency Review workflow added for supply chain visibility.

## [1.0.8] - 2024-12-XX

- Initial public release with `npx @egchq/egc` install flow.
- ChatMCP catalog entry (`egc@egc`).
- OIDC Trusted Publishing for npm.
- SessionStart and PreCompact hooks for Claude Code.
