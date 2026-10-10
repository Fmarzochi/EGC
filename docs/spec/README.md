# EGC Specification

The EGC specification is executable. It lives in JSON Schemas under `schemas/`, in install manifests under `manifests/`, and in tests under `tests/spec/`. This document is the index that ties them together.

## Spec version

`SPEC_VERSION = 0.1.1` (declared in `agent.yaml`)

Semver applies: `MAJOR.MINOR.PATCH`.

- `PATCH`: Documentation, typo, non-contract changes
- `MINOR`: Additive changes to schemas (new optional fields, new optional tiers)
- `MAJOR`: Removed fields, renamed identifiers, changed semantics, new required fields

A 90-day deprecation window applies for `MAJOR` breaking changes to public-facing surfaces (install targets, MCP tool names, hook event names).

## What the spec covers

| Surface | Specified by | Validated by |
|---------|--------------|--------------|
| Integration tiers | [`integration-tiers.md`](./integration-tiers.md) | `tests/spec/integration-tiers.test.js` |
| Agent memory interchange | [`agent-memory-interchange.md`](./agent-memory-interchange.md) | `tests/scripts/export.test.js` (export, section 8.1); gap: reference `egc import` planned |
| Hooks contract | `schemas/hooks.schema.json` | `tests/spec/schemas.test.js` against `hooks/hooks.json`; `scripts/ci/validate-hooks.js` in CI |
| Plugin manifest | `schemas/plugin.schema.json` | `tests/spec/schemas.test.js` against `.gemini-plugin/plugin.json`; `tests/plugin-manifest.test.js` checks the manifests field by field |
| Runtime map | `schemas/runtime-map.schema.json` | `tests/spec/schemas.test.js` against the file `scripts/runtime/discovery.js` writes |
| Install profiles | `schemas/install-profiles.schema.json` | `tests/spec/schemas.test.js` against `manifests/install-profiles.json`; `scripts/ci/validate-install-manifests.js` in CI |
| Install modules | `schemas/install-modules.schema.json` | `tests/spec/schemas.test.js` against `manifests/install-modules.json`; `scripts/ci/validate-install-manifests.js` in CI |
| Install components | `schemas/install-components.schema.json` | `tests/spec/schemas.test.js` against `manifests/install-components.json`; `scripts/ci/validate-install-manifests.js` in CI |
| Package manager detection | `schemas/package-manager.schema.json` | `tests/spec/schemas.test.js` against the `package-manager.json` that `scripts/lib/package-manager.js` writes |
| Provenance metadata | `schemas/provenance.schema.json` | `tests/spec/schemas.test.js` against the file `scripts/lib/skill-evolution/provenance.js` writes |
| State store | `schemas/state-store.schema.json` | At runtime by `scripts/lib/state-store/schema.js`; `tests/lib/state-store.test.js` |
| EGC install config | `schemas/egc-install-config.schema.json` | At runtime by `scripts/lib/install/config.js`; `tests/lib/install-config.test.js` |
| Install state | `schemas/install-state.schema.json` | `tests/spec/schemas.test.js` against the state `scripts/lib/install-state.js` creates; at runtime by `scripts/lib/install-state.js` |

`tests/spec/schemas.test.js` fails when a schema in `schemas/` has no case, so a new schema needs its data in that test.

## Entry points by audience

**Adding a new harness?** Read [`integration-tiers.md`](./integration-tiers.md).

**Implementing portable agent memory?** Read [`agent-memory-interchange.md`](./agent-memory-interchange.md).

**Implementing a custom hook?** Read `schemas/hooks.schema.json` and `tests/hooks/hooks.test.js` for working examples.

**Auditing your fork?** Run `node scripts/harness-audit.js`.

**Migrating between MAJOR versions?** Read the changelog. There are no ADRs yet (see below).

## What is NOT yet specified

This section is deliberately public. Honest gap-tracking beats aspirational omission.

- **Harness contract schema**: there is no schema for it yet. The contract is implicit in `scripts/install-apply.js`. This is the next maturation step
- **Per-harness conformance tests**: there are no per-target smoke tests yet. They would validate that each harness install produces the documented filesystem layout
- **ADRs**: there is no ADR folder yet. ~5-7 retroactive ADRs are needed for decisions already taken (LEGACY_PLUGIN_SLUG, two MCP servers, SQLite local, tier-3 Claude Code, etc.)
- **HARNESS-{target}.md per Tier 1/2 target**: one-page summary per target with maintainer, install example, known edge cases

## Compatibility commitments

- All 23 `SUPPORTED_INSTALL_TARGETS` identifiers (`egc`, `claude`, `cursor`, `antigravity`, `auggie`, `codex`, `qwen`, `opencode`, `codebuddy`, `windsurf`, `amp`, `copilot`, `zed`, `kiro`, `trae`, `junie`, `goose`, `openhands`, `aider`, `cline`, `warp`, `kimi`, `crush`) are stable. They will not be renamed within `0.x`. The ids `gemini`, `continue` and `roocode` were retired on 2026-08-16 (#1279) and `amazonq` on 2026-09-30; `egc install`, `egc doctor`, `egc repair` and `egc auto-update` still recognize them and explain the retirement, while the catalog queries reject them as unknown targets
- The Tier 2 install entry points (`.kiro/install.sh`, `.trae/install.sh`, `.codebuddy/install.sh` and its Node twin) were retired after 1.1.22; `egc install --target <tool> --profile full` is the entry point for every tool
- The Tier 3 protocol injection target paths (`~/.claude/CLAUDE.md` for Claude Code) are stable within `0.x`
- JSON Schema field names are stable within `MINOR` versions. Removals require a `MAJOR` bump
- Legacy plugin identifiers (`everything-gemini`, `everything-gemini@everything-gemini`) remain resolvable indefinitely via `scripts/lib/resolve-egc-root.js` fallback chain. This is permanent backward compatibility
