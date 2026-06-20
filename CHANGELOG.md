# Changelog

All notable changes to EGC are documented here.

## [1.1.1] - 2026-06-20

### New Features

- **`egc watch`** — bidirectional sync daemon. Watches all EGC-managed tool config files in the project. When context is edited directly in any tool file (Cursor, Gemini CLI, GitHub Copilot, Windsurf, etc.), the change is extracted from the EGC block and synced to all other tools and back to `~/.egc/state/` automatically. Handles atomic saves (VS Code, Cursor, Windsurf rename-based writes) and Windows EPERM events.

### Memory Improvements

- **`update_state` propagates to 11 tool config files** — calling `update_state` now writes the new context to every EGC-managed file found in the project: `.cursor/rules/egc-context.mdc`, `.github/copilot-instructions.md`, `GEMINI.md`, `.windsurf/rules/egc-context.md`, `.trae/rules/egc-context.md`, `.rules` (Zed), `.clinerules` (Cline), `CONVENTIONS.md` (Aider), `.cursorrules`, `AGENTS.md`, and `llms.txt`. No extra calls needed — one `update_state` keeps every tool in sync.

### Bug Fixes

- Fixed `update_state` propagation to GitHub Copilot: guard now correctly detects the existing EGC block before inserting.
- Fixed multi-line Context section replacement in bidirectional sync merge.
- Fixed state file path resolution in detached HEAD / non-git directories.
- Fixed `StateWatcher.start()` to return the count of successfully attached watchers rather than the count of discovered files.

## [1.1.0] - 2026-06-13

### New Tools

- **`compress_observations`** - Compresses raw hook observations into structured typed summaries (`tool_failure`, `tool_success`, `file_edit`, etc.) using rule-based analysis. Reduces token usage when injecting observation history into new sessions. Contributed by [@Kunall7890](https://github.com/Kunall7890).

- **`detect_patterns`** - Analyzes runtime events from the state-store database to surface repeated commands and recurring errors across sessions. Helps identify automation candidates and structural issues that persist between conversations.

- **`working_memory`** - Stores transient context within a session with configurable TTL. Entries expire automatically so the memory store does not accumulate stale data across sessions. Exposed as `working_memory_set`, `working_memory_get`, and `working_memory_list`.

- **`lessons`** - Records cross-session knowledge with confidence decay. Each lesson tracks how many times it was reinforced and when it was last seen; confidence degrades over time so stale lessons surface for review rather than being applied forever. Exposed as `lesson_save`, `lesson_recall`, and `lesson_reinforce`.

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
