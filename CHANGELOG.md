# Changelog

All notable changes to EGC are documented here.

## [1.1.9] - 2026-07-11

### Security

- **`egc-memory`: TOCTOU race in encryption key generation eliminated**: `loadOrCreateEncKey` used to leave a window where a concurrent process (e.g. a background agent's own `egc-memory` server starting before `~/.egc/encryption.key` existed) could read a key file that was created but not yet fully written. In the original exclusive-write approach, it could also silently generate and cache its own discarded key for the rest of the process lifetime. Key publication is now atomic (write-to-temp plus `fs.linkSync`), so a racing reader either sees no file or a fully-written one, never a partial write. (#696)
- **`resolveProjectPath`: cwd/PWD fallback fixed**: `process.cwd() || process.env.PWD` never reached the `PWD` fallback, because `process.cwd()` throws rather than returning a falsy value when the working directory is unavailable. Now wrapped in try/catch so the documented fallback actually triggers. (#696)

### New Features

- **`update_state`: recovery path for undecryptable state files**: a state file that fails to decrypt (corrupted, or encrypted under an orphaned key from a race) used to permanently block every future `get_state`/`update_state` call for that project, with no sanctioned way to recover: not through the tool itself, and not through the EGC Guardian, which blocks raw shell access to `~/.egc/state/**` by design. `update_state` now accepts an optional `force: true`: when the existing file cannot be decrypted, it is quarantined (renamed to a `.corrupted-backup-<timestamp>` sibling, never deleted) and the call proceeds as a fresh write instead of aborting forever. (#697)

### Contributing

- **Concurrent-access regression tests required**: `CONTRIBUTING.md` and the PR template now require a concurrent-access regression test for any change touching a file shared across concurrent EGC processes (encryption key, state files, install-state, lockfiles under `~/.egc/`), citing the TOCTOU bug above as the motivating example. This bug class is invisible to CodeQL, SonarCloud, and the full test matrix, since none of them reason about interleaving between separate process executions. (#697)

## [1.1.10] - 2026-07-11

### Bug Fixes

- **`egc status`: install health now reflects reality**: `egc status` always reported "Install health: missing" regardless of actual install state, because `upsertInstallState()`, the function that populates the SQLite table `status` reads, was never called anywhere in the install pipeline. `doctor`, `repair`, `auto-update`, and `list-installed` were unaffected, since they read the JSON install-state files directly. Both real completion points (a fresh install and repair/auto-update) now sync into the status store right after writing the JSON file, fire-and-forget so a status-store write failure can never block or fail a real install. Verified end-to-end in a sandboxed environment: status went from "missing" to "healthy" immediately after a real install. (#699)

## [1.1.8] - 2026-07-11

### New Features

- **Continue.dev support**: added as the 14th supported harness (Tier 1). Skills install flat at `~/.continue/skills/<name>/` in both home and project scope, matching the layout of the other Tier 1 targets. (#693)
- **`autonomous-lesson-learning` skill**: orchestrates `continuous-agent-loop` patterns with the `egc-memory` lesson tools (`lesson_recall`, `lesson_save`, `lesson_reinforce`) so long-running autonomous loops recall known failure modes before acting and record new ones as they happen. (#692)

### Security

- **EGC Guardian: granular credential denylist**: whole-directory blocks on `~/.claude`, `~/.cursor`, `~/.gemini`, and `~/.config` were replaced with a denylist of the specific credential files each AI tool actually stores (OAuth tokens, session files, API keys). The old whole-directory block was breaking legitimate functionality (native memory, skills, and EGC's own install) in several harnesses without any real security gain, since the actual secret was always one specific file, never the whole directory. (#691)
- **`runCommand`**: `execSync` replaced with `spawnSync` plus argv tokenization, removing a shell-injection surface in command execution. (#690)
- **`reduce_context`**: file reads now go through a single file handle (open, stat, read, close) instead of separate `statSync`/`readFile` calls, closing a TOCTOU race on the byte-size limit check. (#690)
- **`auto_learn`**: `project_path` is now resolved with `realpathSync` and checked against the protected-path list before use. (#690)

### Bug Fixes

- **State-store write debounce**: writes to the SQLite-backed state store are now debounced (50ms) with a synchronous flush on the first write, restoring error logging that a prior debounce attempt had dropped silently. (#690)

## [1.1.7] - 2026-07-06

### Bug Fixes

- **stress-tests: null guards in db-adapter**: `.get()` results are now checked before property access in all db-adapter stress test assertions. (#635)
- **stress-tests: null guards in state-store and telemetry**: snapshot existence guard added before `.workers.length` access; `!= null` replaces `!== null` to cover `undefined` returns. (#636)
- **telemetry: `ping()` refactored to `Promise.resolve().then().catch()`**: the previous `try/catch` wrapping a `fetch().catch()` was flagged by SonarCloud S4822 as redundant: promise rejection is already handled by the inner `.catch()`. Ping now uses `Promise.resolve().then(() => fetch(...)).catch(() => {})` which also fixes a subtle timing issue in tests. (#637)
- **Windows crash fix consolidated**: idempotent DB close, BOM-safe JSON parsing, `ping()` async fix, and graceful process exit from the Windows libuv crash patch are combined in one clean commit with co-authorship credited to @fuentes71. (#634)

## [1.1.6] - 2026-07

### New Features

- **`egc replay`**: session playback with timeline scrubbing. Replay any past session event by event with full timeline control. Files added: `scripts/replay.js`, `dashboard/public/replay.html`. (#618, contributed by @Maqbool61)
- **`egc budget`**: per-session token and cost limits enforced at the PreToolUse hook. Commands are blocked when the budget is exceeded. (#610, contributed by @Kunall7890)
- **`egc plugin`**: community plugin registry. Install, list, remove, and update skills/agents/rules from npm or a local path: `egc plugin install <name>`. (#611, contributed by @Kunall7890)
- **Team memory sync via git backend**: `egc-memory` now supports syncing lessons and decisions across teammates via a git remote. Context that was previously trapped in a single developer's local session is now shareable. (#606, contributed by @Kunall7890)
- **Native Zed IDE integration**: `egc install --target zed` registers `egc-guardian` and `egc-memory` directly into `~/.config/zed/settings.json` under `context_servers`. Paths are resolved at install time. Closes #602. (#626, contributed by @Maqbool61)
- **AES-256-GCM encryption for state files at rest**: every `.egc/state/` file is now encrypted. Key lives at `~/.egc/egc.key` (mode 0600, auto-generated). Transparent to all existing workflows: `get_state` and `update_state` handle encryption/decryption automatically. Pure Node.js built-in crypto. Closes #579. (#627, contributed by @Maqbool61)
- **HMAC-SHA256 integrity check on state files**: a per-user key at `~/.egc/integrity.key` (mode 0600) and a sidecar `.hmac` file are written alongside every state file. `get_state` verifies on read (warns on mismatch, never blocks). Closes #580. (#625, contributed by @Maqbool61)
- **Guardian enforcement at the harness level**: every Bash command and every Write/Edit/MultiEdit target is validated by the egc-guardian validator through PreToolUse hooks before it executes. A new UserPromptSubmit hook (`prompt-router.js`) routes every prompt through the component catalog and injects recommended skills and agents into context. (#568, #633)
- **`orchestrate_task` now performs real skill/agent/rule routing**: a build-time generator indexes the full component catalog and the guardian classifies each task prompt against it. LLM-based semantic routing available when a provider API key is set; falls back to local keyword scorer otherwise. (#566)
- **Dashboard session export**: session data can now be exported as CSV or JSON directly from the EGC Dashboard. (#595, contributed by @Kunall7890)
- **Continue.dev native MCP registration**: `egc install` auto-detects Continue.dev and registers `egc-guardian` and `egc-memory` via standalone YAML block files in `~/.continue/mcpServers/`. (#564, contributed by @Maqbool61)
- **Community translations**: Korean (#518, @minus43), Russian (#543, @Vile93), Japanese (#614, @VIUK-XV), Arabic, Hindi, Portuguese, Spanish (8 languages total).
- **VS Code + GitHub Copilot installation guide**: setup section added to all 8 language READMEs. (#631)

### Security

- **`egc-guardian` scoped rate limiter per project path**: prevents DoS via request flooding from a single project. (#544, contributed by @developmentwithparth1311)
- **POST /event body capped at 256 KB**: prevents memory exhaustion from oversized event payloads. (#551, contributed by @developmentwithparth1311)
- **Path traversal guard**: static file server in the dashboard is protected against `../` traversal attacks. (#537, contributed by @Vile93)
- **`audit.log` chmod 600**: audit log file now created with restrictive permissions. (#534, contributed by @Maqbool61)
- **Guard clause against missing `ide` field in `accumulateEvent`**: prevents silent telemetry state corruption. 8 regression tests added. (#536, contributed by @BlackPool25)

### Bug Fixes

- **`egc install` now wires all four Claude Code hooks correctly**: UserPromptSubmit (auto-intuition) and PreToolUse (guardian enforcement) were never registered in `~/.claude/settings.json`. All four hooks are now active after `egc install` or `egc repair`. (#596)
- **codebuddy-adapter: hybrid debounce and extension filter**: fires immediately on first event, coalesces follow-ups with 200 ms trailing edge, filters temp files and restricts to recognized log extensions. Closes #506. (#562, contributed by @Maqbool61)
- **VS Code Copilot log detection by modification time**: EGC now picks the newest Copilot log file by `mtimeMs` instead of the first match, fixing incorrect session attribution. (#565, contributed by @Vile93)
- **`egc replay` strict CLI flag validation**: unrecognized flags now surface a clear error message. Closes #620. (#621, contributed by @developmentwithparth1311)
- **`egc replay` JSON output streamed to stdout**: fixes SonarCloud S5145 log-injection finding; `--json` branch now writes to `process.stdout.write` directly. (#622)

## [1.1.5] - 2026-06-24

### Bug Fixes

- **SessionStart hook no longer crashes on startup**: the install plan now copies `propagate-state.js` and `project-detect.js` into `~/.claude/egc/lib/` alongside the hook script. Both `require()` calls are also wrapped in try/catch so existing installs degrade gracefully until `egc repair` runs.
- **`egc init` opens the browser automatically** after starting the dashboard, and also when the dashboard was already running.
- **ESLint now ignores `.claude/worktrees/` and `dashboard/`**: eliminates lint CI failures caused by Claude Code agent worktrees being scanned and service-worker browser globals in the dashboard files.

## [1.1.4] - 2026-06-24

### Bug Fixes

- **npm package corrected**: `dashboard/` directory and the `ws` dependency were missing from the v1.1.3 npm tarball. Users who installed v1.1.3 globally and saw `EGC Dashboard not found. Expected: .../dashboard/server.js` should run `npm install -g @egchq/egc` to get the fix.

## [1.1.3] - 2026-06-24

### New Features

- **EGC Dashboard** (`egc dashboard`): real-time Mission Control panel at `http://localhost:7890`. Shows live tool calls, file edits, shell commands, token usage, memory state, and agent status as your AI works. Auto-starts after `egc init`. Runs as a background WebSocket server; stop with `egc dashboard stop` and check status with `egc dashboard status`.
- **IDE hook emitters**: Cursor, Kiro, and OpenCode now emit structured hook events to the dashboard over WebSocket. Tool calls, file writes, and shell commands appear in real time in the Mission Control panel.

### Bug Fixes

- Fixed OpenAI tool serialization: `parameters` is now always emitted as an object, preventing schema validation errors with strict OpenAI-compatible endpoints.
- Fixed async `ReActAgent` iteration: the agent loop now correctly awaits each tool call result before continuing.
- Fixed stale `X-Title` header in the OpenRouter provider: the header is now derived from the live session title instead of a startup-time snapshot.
- Fixed `GeminiProvider` null content crash: provider now skips `null` content parts instead of throwing on `.text` access.

## [1.1.2] - 2026-06-20

### New Features

- **`egc watch`**: bidirectional sync daemon. Watches all EGC-managed tool config files in the project. When context is edited directly in any tool file (Cursor, Gemini CLI, GitHub Copilot, Windsurf, etc.), the change is extracted from the EGC block and synced to all other tools and back to `~/.egc/state/` automatically. Handles atomic saves (VS Code, Cursor, Windsurf rename-based writes) and Windows EPERM events.
- **`auto_learn`**: new `egc-guardian` MCP tool. Mines session failures from hook event history, identifies recurring errors, and reinforces actionable lessons automatically so they are available to the AI on the next session.

### Memory Improvements

- **`update_state` propagates to 11 tool config files**: calling `update_state` now writes the new context to every EGC-managed file found in the project: `.cursor/rules/egc-context.mdc`, `.github/copilot-instructions.md`, `GEMINI.md`, `.windsurf/rules/egc-context.md`, `.trae/rules/egc-context.md`, `.rules` (Zed), `.clinerules` (Cline), `CONVENTIONS.md` (Aider), `.cursorrules`, `AGENTS.md`, and `llms.txt`. One call keeps every tool in sync.
- **Natural language interface triggers** added to the EGC block in all propagated files. AI tools that read the block now understand natural language phrases ("remember this", "save to memory", etc.) as EGC tool invocations.

### Guardian Pipeline

- **CacheAligner**: normalizes repeated context blocks before compression to reduce redundancy.
- **ContentRouter**: detects payload type and routes to the appropriate compressor.
- **SmartCrusher**: deduplicates JSON arrays structurally, preserving semantic meaning while cutting token count.
- **Headroom Phase 2**: optional deep compression pass for large payloads that exceed the primary budget.
- All modules are wired into `reduce_context` transparently.

### Infrastructure

- **sql.js replaces better-sqlite3**: the state store now uses a pure-JavaScript/WebAssembly SQLite build. No native compilation, no node-gyp, no build tools required. Works on Linux, macOS, Windows, ARM, and Alpine out of the box.
- **GitLab CI and mirror**: full pipeline with lint and tests on Node 20/22, mirroring automatically from GitHub. Pinned actions and workflow-level `permissions: {}` for security.
- **Code of Conduct**: Contributor Covenant added. All contributors and community members are expected to follow it.

### Bug Fixes

- Fixed `update_state` propagation to GitHub Copilot: guard now correctly detects the existing EGC block before inserting.
- Fixed multi-line Context section replacement in bidirectional sync merge.
- Fixed state file path resolution in detached HEAD / non-git directories.
- Fixed `StateWatcher.start()` to return the count of successfully attached watchers rather than the count of discovered files.
- Fixed `egc doctor` to remove stale `better-sqlite3` references after the sql.js migration.
- Pinned `undici` to 6.27.0 in both MCP servers, patching a known CVE.
- Fixed session start hook: the AI had no way to know which agents applied to each project. Session start now detects the project stack and emits a briefing with relevant agents at the start of every session, closing the gap between what EGC promised and what it actually delivered.

## [1.1.1] - 2026-06-19

### New Tools

- **`lesson_recall`** upgraded to BM25 full-text search via FTS5 virtual table. Searching for related lessons now ranks results by relevance instead of doing plain substring matching. Existing lessons are backfilled on first startup.

### Bug Fixes

- Fixed state DB path: `state-db-writer.js`, `runtime-snapshot.js`, and `detect_patterns` now resolve the path via `getEGCDir()` instead of hardcoding `~/.gemini`. Claude Code, Cursor, and VS Code users whose memory pipeline was silently broken are now fixed.
- Fixed hook commands to use `process.execPath` instead of bare `node`, eliminating PATH resolution failures with nvm, mise, fnm, and GUI app launchers.
- Fixed `egc init` to warn clearly when `better-sqlite3` native module is unavailable; `egc doctor` also reports missing `state.db`.
- Fixed `detect_patterns` to probe known harness locations for `state.db` instead of hardcoding `~/.gemini`.

### New Models (community contribution by [@muhammadhasnain3031](https://github.com/muhammadhasnain3031))

- Added 7 OpenRouter model mappings to `ModelResolver`: DeepSeek R1, DeepSeek Chat V3, Qwen3 235B, Qwen3 32B, Llama 4 Maverick, Llama 4 Scout, Llama 3.3 70B Instruct. Each entry includes capability metadata, fallback chains, context window, vision and tool support flags.

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
