# EGC Architecture

EGC ships one production runtime alongside an exploratory kernel
direction kept under `architecture/` for research and
ecosystem-evolution work. This page is the index — read it first,
then drill into the specific documents below.

## Runtime

### Node.js + MCP runtime (CI-covered)

The production surface that powers the Gemini Code, Codex, Cursor,
Antigravity, OpenCode, Kiro, Trae, and Codebuddy harnesses.

| Layer | Path | Role |
|---|---|---|
| Manifests | `.gemini-plugin/`, `.codex-plugin/`, `.gemini-plugin/marketplace.json` | Static plugin discovery |
| Install adapters | `scripts/lib/install-targets/` | Per-target materialization |
| Install entry | `scripts/install-apply.js`, `install.sh`, `install.ps1` | User-facing installers |
| Hooks pipeline | `hooks/hooks.json` + `scripts/hooks/*` | Pre/Post-tool, session, governance hooks |
| CI gates | `scripts/ci/validate-*.js`, `scripts/ci/catalog.js` | Workflow validation |

The Node/MCP runtime is fully exercised by the CI matrix
(`.github/workflows/ci.yml`, `reusable-test.yml`,
`reusable-validate.yml`) across Linux/macOS/Windows × Node 20/22 ×
npm/yarn/bun.

### Dormant scaffolding (preserved)

- `scripts/runtime/{router,discovery,mount-all,unmount-all,activator}.js`
- `scripts/orchestration/router.py`
- `scripts/health-check.js`, `scripts/generate-plugin-manifest.js`

These resolve a non-existent `registry/` path and have no callers.
See `scripts/runtime/README.md` and `governance/SUBSYSTEM-MAP.md` for the
DORMANT status.

## EGC 2.0 architectural exploration

`EGC_2.0_BLUEPRINT.md` and `EGC_2.0_TECHNICAL_DESIGN.md` collect
ecosystem-evolution research around a unified-control-plane variant
(Rust kernel + Python LLM engine + Node hook worker + SQLite state
store). They are advanced runtime studies, not a replacement schedule
for the production runtimes documented above.

The Rust scaffold at `egc/` is reserved for that exploration. It does
not displace the current production runtimes.

## Documents in this folder

| File | Scope |
|---|---|
| `ARCHITECTURE-IMPROVEMENTS.md` | Cross-cutting improvements and refactors landed during v1 stabilization |
| `EGC_2.0_BLUEPRINT.md` | Vision for the v2.0 Agent OS |
| `EGC_2.0_TECHNICAL_DESIGN.md` | v2.0 component integration and IPC contracts |
| `SELECTIVE-INSTALL-ARCHITECTURE.md` | Module/profile system in `manifests/install-*.json` |
| `SELECTIVE-INSTALL-DESIGN.md` | Selective install design rationale and per-target rules |
| `SINGLE-AGENT-OPERATIONAL-MODEL.md` | Authoritative single-agent execution model |
| `continuous-learning-v2-spec.md` | Continuous-learning v2 skill specification |
| `cross-harness.md` | How a single skill source surfaces across Gemini Code, Codex, Cursor, OpenCode |
