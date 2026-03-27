# ECC2 Codebase Research Report

**Date:** 2026-03-26
**Subject:** `ecc-tui` v0.1.0 — Agentic IDE Control Plane
**Total Lines:** 4,417 across 15 `.rs` files

## 1. Architecture Overview

ECC2 is a Rust TUI application that orchestrates AI coding agent sessions. It uses:
- **ratatui 0.29** + **crossterm 0.28** for terminal UI
- **rusqlite 0.32** (bundled) for local state persistence
- **tokio 1** (full) for async runtime
- **clap 4** (derive) for CLI

### Module Breakdown

| Module | Lines | Purpose |
|--------|------:|---------|
| `session/` | 1,974 | Session lifecycle, persistence, runtime, output |
| `tui/` | 1,613 | Dashboard, app loop, custom widgets |
| `observability/` | 409 | Tool call risk scoring and logging |
| `config/` | 144 | Configuration (TOML file) |
| `main.rs` | 142 | CLI entry point |
| `worktree/` | 99 | Git worktree management |
| `comms/` | 36 | Inter-agent messaging (send only) |

### Key Architectural Patterns

- **DbWriter thread** in `session/runtime.rs` — dedicated OS thread for SQLite writes from async context via `mpsc::unbounded_channel` with oneshot acknowledgements. Clean solution to the "SQLite from async" problem.
- **Session state machine** with enforced transitions: `Pending → {Running, Failed, Stopped}`, `Running → {Idle, Completed, Failed, Stopped}`, etc.
- **Ring buffer** for session output — `OUTPUT_BUFFER_LIMIT = 1000` lines per session with automatic eviction.
- **Risk scoring** on tool calls — 4-axis analysis (base tool risk, file sensitivity, blast radius, irreversibility) producing composite 0.0–1.0 scores with suggested actions (Allow/Review/RequireConfirmation/Block).

## 2. Code Quality Metrics

| Metric | Value |
|--------|-------|
| Total lines | 4,417 |
| Test functions | 29 |
| `unwrap()` calls | 3 |
| `unsafe` blocks | 0 |
| TODO/FIXME comments | 0 |
| Max file size | 1,273 lines (`dashboard.rs`) |

**Assessment:** The codebase is clean. Only 3 `unwrap()` calls (2 in tests, 1 in config `default()`), zero `unsafe`, and all modules use proper `anyhow::Result` error propagation. The `dashboard.rs` file at 1,273 lines exceeds the repo's 800-line max-file guideline, but it is still manageable at the current scope.

## 3. Identified Gaps

### 3.1 Comms Module — Send Without Receive

`comms/mod.rs` (36 lines) has `send()` but no `receive()`, `poll()`, `inbox()`, or `subscribe()`. The `messages` table exists in SQLite, but nothing reads from it. The inter-agent messaging story is half-built.

**Impact:** Agents cannot coordinate. The `TaskHandoff`, `Query`, `Response`, and `Conflict` message types are defined but unusable.

### 3.2 New Session Dialog — Stub

`dashboard.rs:495` — `new_session()` logs `"New session dialog requested"` but does nothing. Users must use the CLI (`ecc start --task "..."`) to create sessions; the TUI dashboard cannot.

### 3.3 Single Agent Support

`session/manager.rs` — `agent_program()` only supports `"claude"`. The CLI accepts `--agent` but anything other than `"claude"` fails. No codex, opencode, or custom agent support.

### 3.4 Config — File-Only

`Config::load()` reads `~/.claude/ecc2.toml` only. The implementation lacks environment variable overrides (e.g., `ECC_DB_PATH`, `ECC_WORKTREE_ROOT`) and CLI flags for configuration.

### 3.5 Removed Legacy Dependency: `git2`

`git2 = "0.20"` was previously declared in `Cargo.toml` but the `worktree` module shells out to `git` CLI instead. The dependency adds ~30s to clean builds and increases binary size.

### 3.6 No Metrics Aggregation

`SessionMetrics` tracks tokens, cost, duration, tool_calls, files_changed per session. But there's no aggregate view: total cost across sessions, average duration, top tools by usage, etc. The Metrics pane in the dashboard shows per-session detail only.

### 3.7 Daemon — No Health Reporting

`session/daemon.rs` runs an infinite loop checking session timeouts. No health endpoint, no log rotation, no PID file, no signal handling for graceful shutdown. `Ctrl+C` during daemon mode kills the process uncleanly.

## 4. Test Coverage Analysis

29 test functions across 12 test modules:

| Module | Tests | Coverage Focus |
|--------|------:|----------------|
| `config/mod.rs` | 5 | Defaults, deserialization, legacy fallback |
| `session/mod.rs` | 6 | State machine transitions |
| `session/store.rs` | 10 | CRUD, migration, message ops |
| `session/output.rs` | 4 | Ring buffer, broadcast |
| `observability/mod.rs` | 4 | Risk scoring, tool assessment |

**Missing test coverage:**
- `dashboard.rs` — 0 tests (1,273 lines, the largest module)
- `manager.rs` — 0 tests (680 lines, session lifecycle)
- `runtime.rs` — 0 tests (process output capture)
- `daemon.rs` — 0 tests (background monitoring)
- `comms/mod.rs` — 0 tests

The untested modules are the ones doing I/O (spawning processes, writing to SQLite, reading from stdout). These need integration tests with mockable boundaries.

## 5. Security Observations

- **No secrets in code.** Config reads from TOML file, no hardcoded credentials.
- **Process spawning** uses `tokio::process::Command` with explicit `Stdio::piped()` — no shell injection vectors.
- **Risk scoring** is a strong feature — catches `rm -rf`, `git push --force origin main`, file access to `.env`/secrets.
- **No input sanitization on session task strings.** The task string is passed directly to `claude --print`. If the task contains shell metacharacters, it could be exploited depending on how `Command` handles argument quoting. Currently safe (arguments are not shell-interpreted), but worth auditing.

## 6. Dependency Health

| Crate | Version | Latest | Notes |
|-------|---------|--------|-------|
| ratatui | 0.29 | **0.30.0** | Update available |
| crossterm | 0.28 | **0.29.0** | Update available |
| rusqlite | 0.32 | **0.39.0** | Update available |
| tokio | 1 | **1.50.0** | Update available |
| serde | 1 | **1.0.228** | Update available |
| clap | 4 | **4.6.0** | Update available |
| chrono | 0.4 | **0.4.44** | Update available |
| uuid | 1 | **1.22.0** | Update available |

`git2` has been removed (it was unused — the `worktree` module shells out to `git` CLI). Several other dependencies are outdated; update before the next release.

## 7. Recommendations (Prioritized)

### P0 — Quick Wins

1. **Add environment variable support to `Config::load()`** — `ECC_DB_PATH`, `ECC_WORKTREE_ROOT`, `ECC_DEFAULT_AGENT`. Standard practice for CLI tools.

### P1 — Feature Completions

3. **Implement `comms::receive()` / `comms::poll()`** — read unread messages from the `messages` table, optionally with a `broadcast` channel for real-time delivery. Wire it into the dashboard.
4. **Build the new-session dialog in the TUI** — modal form with task input, agent selector, worktree toggle. Should call `session::manager::create_session()`.
5. **Add aggregate metrics** — total cost, average session duration, tool call frequency, cost per session. Show in the Metrics pane.

### P2 — Robustness

6. **Add integration tests for `manager.rs` and `runtime.rs`** — these modules do process spawning and I/O. Test with mock agents (`/bin/echo`, `/bin/false`).
7. **Add daemon health reporting** — PID file, structured logging, graceful shutdown via signal handler.
8. **Task string security audit** — The session task uses `claude --print` via `tokio::process::Command`. Verify arguments are never shell-interpreted. Checklist: confirm `Command` arg usage, threat-model metacharacter injection, input validation/escaping strategy, logging of raw inputs, and automated tests. Re-audit if invocation code changes.
9. **Break up `dashboard.rs`** — extract SessionsPane, OutputPane, MetricsPane, LogPane into separate files under `tui/panes/`.

### P3 — Extensibility

10. **Multi-agent support** — make `agent_program()` pluggable. Add `codex`, `opencode`, `custom` agent types.
11. **Config validation** — validate risk thresholds sum correctly, budget values are positive, paths exist.

## 8. Comparison with Ratatui 0.29 Best Practices

The codebase follows ratatui conventions well:
- Uses `TableState` for stateful selection (correct pattern)
- Custom `Widget` trait implementation for `TokenMeter` (idiomatic)
- `tick()` method for periodic state sync (standard)
- `broadcast::channel` for real-time output events (appropriate)

**Minor deviations:**
- The `Dashboard` struct directly holds `StateStore` (SQLite connection). Ratatui best practice is to keep the state store behind an `Arc<Mutex<>>` to allow background updates. Currently the TUI owns the DB exclusively, which blocks adding a background metrics refresh task.
- No `Clear` widget usage when rendering the help overlay — could cause rendering artifacts on some terminals.

## 9. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Dashboard file exceeds 1500 lines (projected) | High | Medium | At 1,273 lines currently (Section 2); extract panes into modules before it grows further |
| SQLite lock contention | Low | High | DbWriter pattern already handles this |
| No agent diversity | Medium | Medium | Pluggable agent support |
| Task-string handling assumptions drift over time | Medium | Medium | Keep `Command` argument handling shell-free, document the threat model, and add regression tests for metacharacter-heavy task input |

---

**Bottom line:** ECC2 is a well-structured Rust project with clean error handling, good separation of concerns, and strong security features (risk scoring). The main gaps are incomplete features (comms, new-session dialog, single agent) rather than architectural problems. The codebase is ready for feature work on top of the solid foundation.
