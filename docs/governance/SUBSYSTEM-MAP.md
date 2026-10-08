# EGC Subsystem Map

This page classifies the top-level subsystems and notable subtrees of the
EGC repository so contributors can tell at a glance what is
alive, what is generated, and what is dormant. Every path below exists on
`main`, and `tests/docs/subsystem-map-docs.test.js` fails when one stops
existing.

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
| `agents/` | ACTIVE | Agent definitions, checked by `scripts/ci/validate-agents.js` |
| `commands/` | ACTIVE | Slash commands, checked by `scripts/ci/validate-commands.js` |
| `skills/` | ACTIVE | Skills, checked by `scripts/ci/validate-skills.js` and `scripts/ci/validate-skill-frontmatter.js` |
| `rules/` | ACTIVE | Cross-language coding rules, checked by `scripts/ci/validate-rules.js` |
| `hooks/hooks.json` | ACTIVE | Hook manifest, checked by `scripts/ci/validate-hooks.js` against `schemas/hooks.schema.json` |
| `scripts/hooks/` | ACTIVE | Hook implementations started from `hooks/hooks.json` |
| `scripts/lib/` | ACTIVE | Shared libraries for the CLI, the installer and the hooks |
| `scripts/lib/install-targets/` | ACTIVE | One adapter per install target, registered in `scripts/lib/install-targets/registry.js` |
| `scripts/ci/` | ACTIVE | Validators and smoke checks run by `.github/workflows/ci.yml`; `scripts/ci/codex-mirror.js` runs from `tests/ci/codex-mirror-parity.test.js` |
| `scripts/egc.js` | ACTIVE | `bin: egc` |
| `scripts/install-apply.js` | ACTIVE | `bin: egc-install` |
| `mcp/servers/egc-guardian/`, `mcp/servers/egc-memory/` | ACTIVE | MCP servers, `bin: egc-guardian` and `bin: egc-memory` |
| `scripts/doctor.js`, `scripts/bootstrap-state-db.js`, `scripts/build-opencode.js` | ACTIVE | npm scripts `doctor`, `bootstrap` and `build:opencode` |
| `scripts/install.sh`, `scripts/install.ps1` | ACTIVE | Cross-platform install entrypoints |
| `manifests/install-modules.json`, `manifests/install-profiles.json`, `manifests/install-components.json` | ACTIVE | Install adapter driver, checked by `scripts/ci/validate-install-manifests.js` |
| `schemas/` | ACTIVE | Partly validated, see [Schemas](#schemas) |
| `agent.yaml` | ACTIVE | Published in the npm package; `scripts/release.sh` bumps its version and `tests/plugin-manifest.test.js` checks it matches `package.json` |
| `.gemini-plugin/`, `.codex-plugin/` | ACTIVE | Plugin manifests |
| `.cursor/`, `.codex/`, `.kiro/`, `.trae/`, `.codebuddy/`, `.opencode/` | ACTIVE | Harness-specific source bundles |
| `.agents/` | ACTIVE | Shared `.agents` tree: `.agents/AGENTS.md`, `.agents/plugins/` and `.agents/skills/` |
| `tests/` | ACTIVE | `*.test.js` run by `tests/run-all.js`; `tests/test_*.py` run by the `pytest tests/` step of `.github/workflows/ci.yml` |
| `src/llm/` | ACTIVE | Python LLM providers, tested by `tests/test_*.py` in CI and reached through `npm run prompt` (`scripts/gemini.js`) |
| `scripts/runtime/discovery.js`, `scripts/runtime/session_bridge.py`, `scripts/runtime/tracer.py` | ACTIVE | See `scripts/runtime/README.md` |

### Schemas

| Schema | Status |
|---|---|
| `schemas/hooks.schema.json` | Validated in CI by `scripts/ci/validate-hooks.js` |
| `schemas/install-modules.schema.json`, `schemas/install-profiles.schema.json`, `schemas/install-components.schema.json` | Validated in CI by `scripts/ci/validate-install-manifests.js` |
| `schemas/egc-install-config.schema.json` | Read at runtime by `scripts/lib/install/config.js` |
| `schemas/install-state.schema.json` | Read at runtime by `scripts/lib/install-state.js` |
| `schemas/state-store.schema.json` | Read at runtime by `scripts/lib/state-store/schema.js` |
| `schemas/agents-registry.schema.json`, `schemas/skills-registry.schema.json`, `schemas/runtime-map.schema.json`, `schemas/package-manager.schema.json`, `schemas/plugin.schema.json`, `schemas/provenance.schema.json` | No validator and no reader yet (#1702) |

### Generated / regeneratable

| Path | Class | Notes |
|---|---|---|
| `internal/registry/runtime-map.json` | GENERATED | Written by `scripts/runtime/discovery.js` after an install from `scripts/install-apply.js`; `internal/` is gitignored |
| `scripts/lib/skill-index.json`, `mcp/servers/egc-guardian/src/catalog-index.ts` | GENERATED | Built by `scripts/build-skill-index.js` |
| `.opencode/dist/` | GENERATED | Built by `npm run build:opencode`; gitignored |
| `node_modules/` | GENERATED | Standard npm |

### Dormant

| Path | Class | Notes |
|---|---|---|
| `scripts/orchestration/`, `scripts/execution/`, `scripts/workflows/` | DORMANT | Python orchestration runtime; no CLI command, hook or npm script starts it |
| `scripts/runtime/*.py` other than `session_bridge.py` and `tracer.py` | DORMANT | Used only by the dormant orchestration runtime, see `scripts/runtime/README.md` |
| `scripts/tests/` | DORMANT | Tests of the orchestration runtime; outside the `pytest tests/` step, so CI does not run them |

`scripts/ci/runtime-topology.js` and `scripts/ci/runtime-snapshot.js` describe
these files for the CI smoke checks; they do not run them.

### Out of scope

`assets/`, `examples/`, `docs/`, `mcp-configs/` and `fuzz/` are user-facing
material or operational fixtures. Classify per-file when a question arises.

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
- Rewritten against `main` on 2026-10-08 (#1764): the rows for files that
  no longer exist were removed, and the classes follow the callers in the
  code.
