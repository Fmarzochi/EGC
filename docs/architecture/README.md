# EGC Architecture

EGC ships one production runtime. This folder documents it, plus an
unimplemented "EGC 2.0" proposal kept for reference. This page is the
index: read it first, then drill into the specific documents below.

## Runtime

### Node.js + MCP runtime (CI-covered)

The production surface that powers the Claude Code, Codex, Cursor,
Antigravity, OpenCode, Kiro, Trae, and Codebuddy harnesses.

| Layer | Path | Role |
|---|---|---|
| Manifests | `.gemini-plugin/`, `.codex-plugin/`, `.gemini-plugin/marketplace.json` | Static plugin discovery |
| Install adapters | `scripts/lib/install-targets/` | Per-target materialization |
| Install entry | `scripts/install-apply.js`, `scripts/install.sh`, `scripts/install.ps1` | User-facing installers |
| Hooks pipeline | `hooks/hooks.json` + `scripts/hooks/*` | Pre/Post-tool, session, governance hooks |
| MCP servers | `mcp/servers/egc-guardian/`, `mcp/servers/egc-memory/` | Guardian validation and session memory (SQLite state store) |
| CI gates | `scripts/ci/validate-*.js`, `scripts/ci/catalog.js` | Workflow validation |

The Node/MCP runtime is exercised by the test matrix in
`.github/workflows/ci.yml` across Linux/macOS/Windows × Node 20/22 ×
npm/yarn/bun. The Python LLM engine under `src/llm/` is covered by the
same workflow's Python job (`python -m pytest tests/`).

### Orchestration and runtime map

- `scripts/orchestration/orchestrator.py` drives the Python orchestration
  layer and imports `scripts/orchestration/router.py` for agent routing.
- `scripts/runtime/discovery.js` compiles the runtime map into
  `internal/registry/runtime-map.json`, a generated file that is not
  tracked. The router, mount and activator scripts that used to sit next
  to it are no longer in the tree.

`scripts/ci/runtime-topology.js` records which of these modules are
wired and how. See `scripts/runtime/README.md` and
`docs/governance/SUBSYSTEM-MAP.md` for the subsystem notes.

## EGC 2.0 proposal (not implemented)

`EGC_2.0_BLUEPRINT.md` and `EGC_2.0_TECHNICAL_DESIGN.md` describe a
proposed unified control plane: a Rust kernel daemon supervising a Python
LLM engine and Node.js hook workers over Protobuf IPC, with one shared
SQLite store. None of it exists in the repository: there is no Rust
code, no `egcd` daemon, no Protobuf or gRPC contract, and no
`~/.gemini/egc/` store. Both pages are kept as a design proposal, not a
description of EGC or a replacement schedule for the runtime above.

## Documents in this folder

| File | Scope |
|---|---|
| `ARCHITECTURE-IMPROVEMENTS.md` | Cross-cutting improvements and refactors landed during v1 stabilization |
| `EGC_2.0_BLUEPRINT.md` | Unimplemented proposal: vision for a v2.0 "Agent OS" |
| `EGC_2.0_TECHNICAL_DESIGN.md` | Unimplemented proposal: v2.0 component integration and IPC contracts |
| `SELECTIVE-INSTALL-ARCHITECTURE.md` | Module/profile system in `manifests/install-*.json` |
| `SELECTIVE-INSTALL-DESIGN.md` | Selective install design rationale and per-target rules |
| `SINGLE-AGENT-OPERATIONAL-MODEL.md` | Authoritative single-agent execution model |
| `continuous-learning-v2-spec.md` | Continuous-learning v2 skill specification |
| `cross-harness.md` | How a single skill source surfaces across Claude Code, Codex, Cursor, OpenCode |
