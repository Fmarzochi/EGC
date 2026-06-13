# EGC Subsystem Map

This page classifies the top-level subsystems and notable subtrees of the
EGC repository so contributors can tell at a glance what is
alive, what is generated, what is preserved for history, and what is
dormant.

## Taxonomy

- **ACTIVE**: invoked by CI, runtime, or supported user flows.
- **GENERATED**: produced by tooling; safe to regenerate.
- **ARCHIVAL**: historical snapshot, intentionally preserved.
- **DORMANT**: code present but not currently wired into any execution path.
- **LEGACY**: superseded; kept for migration compatibility.
- **DEPRECATED**: slated for removal once consumers migrate.

## Map

### Active surfaces

| Path | Class | Notes |
|---|---|---|
| `agents/` | ACTIVE | 62 agent definitions, source of truth |
| `commands/` | ACTIVE | 74 slash commands |
| `skills/` | ACTIVE | 228 skills across 14 namespaces |
| `rules/` | ACTIVE | Cross-language coding rules |
| `hooks/` | ACTIVE | Manifest (`hooks.json`); implementations live in `scripts/hooks/` |
| `scripts/hooks/` | ACTIVE | 25 hooks loaded directly by `hooks/hooks.json`; rest transitive |
| `scripts/lib/` | ACTIVE | Loader libraries used by install adapters |
| `scripts/lib/install-targets/` | ACTIVE | Per-target adapters (cursor, codex, antigravity, gemini, codebuddy, opencode) |
| `scripts/ci/` | ACTIVE | Validators invoked by `.github/workflows/reusable-validate.yml` |
| `scripts/install-apply.js` | ACTIVE | `bin: egc-install` |
| `scripts/egc.js` | ACTIVE | `bin: egc` |
| `scripts/doctor.js`, `scripts/bootstrap-state-db.js`, `scripts/build-opencode.js` | ACTIVE | npm scripts |
| `manifests/install-{modules,profiles,components}.json` | ACTIVE | Install adapter driver |
| `schemas/*.json` | ACTIVE | Validated in CI |
| `.gemini-plugin/`, `.codex-plugin/` | ACTIVE | Plugin manifests |
| `.cursor/`, `.codex/`, `.kiro/`, `.trae/`, `.codebuddy/`, `.opencode/` | ACTIVE | Harness-specific source bundles |
| `.agents/` | ACTIVE | Materialization layer; hot/cold/shadowed taxonomy |
| `tests/` (`*.test.js`) | ACTIVE | Driven by `tests/run-all.js` (glob: `**/*.test.js`) |
| `install.sh`, `install.ps1` | ACTIVE | Cross-platform entrypoints (Windows lane covered by CI) |

### Generated / regeneratable

| Path | Class | Notes |
|---|---|---|
| `src/everything_gemini.egg-info/` | GENERATED | Produced by `pip install -e .` / setuptools; safe to regenerate |
| `.opencode/dist/` | GENERATED | Built by `npm run build:opencode`; gitignored |
| `node_modules/` | GENERATED | Standard npm |
| `internal/registry/runtime-map.json` | ACTIVE | Generated hot cache of the operational topology; updated by `scripts/runtime/discovery.js` |

### Archival

| Path | Class | Notes |
|---|---|---|
| `.agents/.agents/` | ARCHIVAL | Recursive mount artifact preserved since baseline; symlinks now relative; see `.agents/.agents/README.md` |
| `internal/registry/{agents,skills}-registry.json` | ARCHIVAL | Historical inventory snapshots (50 agents / 182 skills) from an earlier release |
| `legacy-command-shims/` | ARCHIVAL | Compatibility shims for `/tdd`, `/eval`, `/verify` muscle memory; own README inside |
| `agent.yaml` | ARCHIVAL | Spec 0.1.0 manifest; no live consumer; useful as historical contract |

### Dormant

| Path | Class | Notes |
|---|---|---|
| `scripts/runtime/` (router, mount-all, unmount-all, activator) | DORMANT | `discovery.js` is ACTIVE, but routing/mounting scripts are dormant. See `scripts/runtime/README.md` |
| `scripts/orchestration/router.py` | DORMANT | Same registry path drift |
| `scripts/health-check.js` | DORMANT | Same registry path drift |
| `scripts/generate-plugin-manifest.js` | DORMANT | Same registry path drift |
| `scripts/ci/validate-no-personal-paths.js` | DORMANT | Regex targets prior owner; not invoked by workflows |
| `tests/test_*.py` (13 files) | DORMANT | Functional but excluded by `tests/run-all.js` glob; CI runs no pytest |
| `src/llm/` (Python LLM dispatcher) | DORMANT-runtime | Importable; only wrapper (`scripts/gemini.js`) targets it, and that wrapper has no current bin/test callers |

### Out of scope

`assets/`, `examples/`, `docs/`, `mcp-configs/`, `plugins/`, `internal/`,
`test-extension/`, `test-hooks/` are user-facing or operational fixtures.
Classify per-file when a question arises.

## Governance policy

- **ACTIVE** items: changes go through normal review.
- **GENERATED** items: do not hand-edit; regenerate from source.
- **ARCHIVAL** items: keep unless explicitly authorised for removal.
- **DORMANT** items: do not revive opportunistically. If a dormant path is
  referenced from documentation, the documentation must say so honestly.
- **LEGACY** / **DEPRECATED** items: include a migration target.

When in doubt: preserve and classify; do not delete.

## Audit history

- Baseline commit `f2bc03a7` published this layout.
- Subsequent CI stabilization fixed lint, Windows quoting, baseline-absent
  path normalization, plugin manifest drift, and absolute-symlink
  portability.
- This map reflects the state after the absolute-symlink portability
  conversion (486 symlinks rewritten from absolute to relative).
