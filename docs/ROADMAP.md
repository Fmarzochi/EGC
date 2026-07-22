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

## v1.1.3 -- v1.1.6: Stability and Ecosystem (Released 2026-07)

What shipped in the 1.1.x patch series:

- EGC Dashboard: real-time mission control at `localhost:7890` with live tool calls, token usage, provider comparison, and session export to CSV/JSON
- IDE hook emitters: Cursor, Kiro, OpenCode, CodeBuddy now emit events to the dashboard in real time
- Guardian Protocol deployed to all install targets: `orchestrate_task`, `validate_command`, `validate_write`, `auto_learn` ship by default
- Guardian enforcement fully harness-level: UserPromptSubmit + PreToolUse hooks wired, prompt routing active on every session (#633)
- `egc replay`: session playback with timeline scrubbing (#618, @Maqbool61)
- `egc budget`: per-session token and cost limits enforced at the PreToolUse hook (#610, @Kunall7890)
- `egc plugin`: community plugin registry -- `egc plugin install <name>` (#611, @Kunall7890)
- Team memory sync via git backend (#606, @Kunall7890)
- Native Zed IDE integration -- `egc install --target zed` (#626, @Maqbool61)
- AES-256-GCM encryption for state files at rest (#627, @Maqbool61)
- HMAC-SHA256 integrity check on state files (#625, @Maqbool61)
- Continue.dev native MCP registration (#564, @Maqbool61)
- VS Code + GitHub Copilot installation guide in all 8 language READMEs (#631)
- Security batch: audit.log chmod 600, path traversal guard, scoped rate limiter per project, POST /event body cap at 256 KB, XSS escaping
- Community translations: Arabic, Hindi, Korean, Russian, Japanese, Spanish, Portuguese -- 8 languages total
- 14 supported AI coding tools

## v1.1.12: Omnipresent Context (Released 2026-07-18)

Memory everywhere, tokens crushed, sessions coordinated:

- User-wide global memory: `update_state` with `scope: "global"` shares preferences and lessons across every project; `get_state` and the session-start hooks append a deduplicated Global Memory section with strict project-over-global precedence (#855)
- Session Bus MVP: `session_announce`, `session_peers`, `claim_path`, `release_path` -- parallel sessions split territory with fail-fast cooperative locks, dead sessions swept after 10 minutes (#858)
- Commit privacy enforced in three layers: `check-state-leak.js`, tracked pre-commit hook, and a CI tree guard; the public baseline of the propagation files now ships zeroed (#856)
- Token Crusher: native shell-output compression engine with `egc run` and the zero-cost `egc saved` report (#857), silent tier A rewrite in the bash dispatcher (#860), status line at `egc init` (#859)
- Multi-session SQLite write arbitration hardened with equal jitter and deeper retries (#853)
- Zero-friction DCO finally works: the prepare-commit-msg hook shipped without its executable bit since #719 (#854)
- 20 supported AI coding tools

## v1.1.13: Commit Privacy Completed (Released 2026-07-18)

Closes the commit-privacy scope started in v1.1.12:

- Git clean filter as the third privacy layer: `egc init` configures `filter.egc-memory.clean` locally and binds the four propagation files in `.git/info/attributes`, so `git add` stages a zeroed blob even when local hooks are bypassed; the working tree keeps the populated memory (#863)
- The installer prints the filter action plan before applying it and honors `--dry-run`; outside a git repository the step is skipped with a reason (#863)

## v1.1.14: Community Wave (Released 2026-07-18)

- README repositioned around the shared brain across all 8 languages (#869), with Chinese Simplified landing as the 9th community translation (#870, @jackmcwin)
- `egc gain`: the full token savings panel, with `egc saved` as the short report (#874)
- Session bus v2: event queue and implicit presence for parallel sessions (#875); three cross-process races closed (#867)
- Secrets redacted in mapped SDK errors, Google API keys covered (#883)
- Guardian command validator: argument-parsing bypasses closed (#882)
- Commit privacy guard extended to all 11 memory propagation targets (#881)
- `claw` and `harness-audit` registered as first-class `egc` commands (#889)
- Team sync degrades to offline errors instead of crashing (#890)
- Lean repository root: tool configuration files moved to their conventional homes (#891)
- `egc install` launches the dashboard right after installing (#893)

## v1.1.15: Universal Crusher and Clean Security (Released 2026-07-21)

- Relicensed from MIT to Apache License 2.0 (#906)
- Dashboard session shim no longer leaves a zombie process after every event (#907, @developmentwithparth1311)
- Lean repository root phase 2: examples, lint, and test configs relocated, redundant files dropped (#908)
- Dashboard offline badge after consecutive poll failures, with per-endpoint failure streaks (#911, @harshjainnn)
- `LLMInput.stream=True` now raises `NotImplementedError` across the OpenAI-compatible providers instead of silently downgrading to a blocking call (#912, @Sufiyan-MSA)
- Dashboard POST /event rejects malformed JSON with a 400 instead of a silent 200 (#917, @harshjainnn)
- Dashboard offline badge reacts to a dead WebSocket, not only to poll failures (#919, @harshjainnn)
- zh-CN README rendering fixed after the closing div (#922, @Aki-new)
- Last em dash removed from the docs per repo writing convention (#929, @aryamirani)
- CLA workflow runs are named after the PR they check instead of the base branch (#930)
- Italian README translation, the 10th language, wired into all language selectors (#933, @LuckysHorizon)
- Bare `egc install` runs the shipped onboarding installers instead of erroring in a clean environment (#937, @Aki-new via #935)
- `egc catalog search <terms>`: ranked keyword search across skills, agents, rules, components and profiles (#939)
- Lean root phase 3: the VERSION file dropped, package.json is the single version source (#940)
- Official Hugging Face Space launched: https://huggingface.co/spaces/fmarzochi/EGC
- Dashboard /ping polling survives WebSocket outages on a single self-healing timer chain (#943, @Tyr1onX)
- The generate() error wrapper deduplicated into one shared hook across the OpenAI-compatible providers (#944, @harshjainnn)
- Dashboard replay recovers the event file path from the detail field (#950, @Tyr1onX)
- Dashboard caps WebSocket reconnect attempts and surfaces a visible disconnected state (#951, @Tyr1onX)
- Dashboard watcher closes a stat-open TOCTOU race by fstat-ing the already-open descriptor (#953, @Tyr1onX)
- Dependency advisories patched across the MCP servers and fuzz lockfiles (#955)
- Agent Memory Interchange draft specification published (#947)
- Token Crusher now rewrites shell commands before they run and is propagated across six hook-capable hosts: Claude Code, Codex, CodeBuddy, Copilot, Antigravity and Continue (#956, #958, #959, #964)
- Dashboard honors EGC_PORT instead of hardcoding port 7890 (#963, @Maqbool61)
- Dashboard POST /event preserves multi-byte UTF-8 characters split across TCP chunks (#960, @hanu-14)
- Explicit per-client HTTP timeout across every LLM provider (#961, @hanu-14)
- Native Roo Code install target (#957, @Tyr1onX)
- Native Qwen Code install target (#962, @Tyr1onX)
- Native Cline install target, bringing EGC to 23 supported AI coding tools (#965, @Tyr1onX)
- `stream=True` now raises `NotImplementedError` across the five remaining native providers (Claude, Cohere, Gemini, Ollama, Vertex AI), completing stream-guard coverage (#924, @hanu-14)
- Dashboard serves static files added after startup without a restart, with a symlink guard and a debounced manifest rebuild that preserves the traversal protection (#928, @hanu-14)
- French README translation, the 11th language, wired into every language selector (#948, @ankit24417-sys)
- Turkish README translation, the 12th language, wired into every language selector (#970, @Iahmacun)
- German README translation, the 13th language, wired into every language selector (#972, @rathaur-ankit)
- High-severity advisories cleared: fast-uri and linkify-it across the root and mcp-server lockfiles (#967), and `@hono/node-server` forced to 2.x via npm override to close the last Dependabot and Scorecard findings (#968)
- ClusterFuzzLite weekly schedule disabled while upstream is dead-locked for JavaScript, keeping manual `workflow_dispatch` (EGC#910)

## Unreleased (on main)

_Nothing yet since v1.1.15._

## v1.2.0: Teams

Multi-developer workflows and shared context:

- Shared state between team members (multi-user installations beyond git-backend team memory)
- Organization-level installations and role-based context scoping
- Cross-project memory federation
- Stable MCP server API with versioned interfaces
- `egc-guardian` and `egc-memory` promoted to GA with backward-compatibility guarantees

## v1.3.0: Growth

- Community translations: German, French, Italian, Turkish, Ukrainian, Malay
- Per-project skill profiles and overrides
- OSS-Fuzz integration for continuous fuzz testing

## v2.0.0: Enterprise

- Formal security review by an independent party
- SBOM (Software Bill of Materials) generation
- Assurance case documenting security properties
- Contribution from at least two active maintainers (bus factor >= 2)

## Non-Goals

- EGC does not aim to replace AI providers: it augments them
- EGC does not store or transmit user code to any third party
- EGC does not require cloud connectivity for local installations
