# EGC Specification

The EGC specification is executable. It lives in JSON Schemas under `schemas/`, in install manifests under `scripts/lib/`, and in tests under `tests/spec/`. This document is the index that ties them together.

## Spec version

`SPEC_VERSION = 0.1.0` (declared in `agent.yaml`)

Semver applies: `MAJOR.MINOR.PATCH`.

- `PATCH`: Documentation, typo, non-contract changes
- `MINOR`: Additive changes to schemas (new optional fields, new optional tiers)
- `MAJOR`: Removed fields, renamed identifiers, changed semantics, new required fields

A 90-day deprecation window applies for `MAJOR` breaking changes to public-facing surfaces (install targets, MCP tool names, hook event names).

## What the spec covers

| Surface | Specified by | Validated by |
|---------|--------------|--------------|
| Integration tiers | [`integration-tiers.md`](./integration-tiers.md) | `tests/spec/integration-tiers.test.js` |
| Agent memory interchange | [`agent-memory-interchange.md`](./agent-memory-interchange.md) | gap: reference `egc export` / `egc import` pair planned |
| Hooks contract | `schemas/hooks.schema.json` | `tests/hooks/hooks.test.js` |
| Plugin manifest | `schemas/plugin.schema.json` | `tests/plugin-manifest.test.js` |
| Runtime map | `schemas/runtime-map.schema.json` | `tests/test_orchestrator.py` |
| Install profiles | `schemas/install-profiles.schema.json` | `tests/lib/install-manifests.test.js` |
| Install modules | `schemas/install-modules.schema.json` | `tests/scripts/doctor.test.js` |
| Install components | `schemas/install-components.schema.json` | `tests/lib/install-manifests.test.js` |
| Package manager detection | `schemas/package-manager.schema.json` | `tests/scripts/auto-update.test.js` |
| Provenance metadata | `schemas/provenance.schema.json` | `tests/lib/skill-dashboard.test.js` |
| State store | `schemas/state-store.schema.json` | `tests/lib/state-store.test.js` |
| EGC install config | `schemas/egc-install-config.schema.json` | `tests/lib/install-targets.test.js` |
| Install state | `schemas/install-state.schema.json` | gap: no dedicated test (validated indirectly via install-apply flow) |
| Agents registry | `schemas/agents-registry.schema.json` | gap: no dedicated validator |
| Skills registry | `schemas/skills-registry.schema.json` | gap: no dedicated validator |

## Entry points by audience

**Adding a new harness?** Read [`integration-tiers.md`](./integration-tiers.md).

**Implementing portable agent memory?** Read [`agent-memory-interchange.md`](./agent-memory-interchange.md).

**Implementing a custom hook?** Read `schemas/hooks.schema.json` and `tests/hooks/hooks.test.js` for working examples.

**Auditing your fork?** Run `node scripts/harness-audit.js`.

**Migrating between MAJOR versions?** Read the changelog plus the relevant ADR under `docs/decisions/` (planned).

## What is NOT yet specified

This section is deliberately public. Honest gap-tracking beats aspirational omission.

- **Harness contract schema**: `harness-contract.schema.json` does not exist yet. The contract is implicit in `install-apply.js`. This is the next maturation step
- **Per-harness conformance tests**: `tests/spec/{target}.smoke.test.js` does not exist yet. Smoke tests will validate that each harness install produces the documented filesystem layout
- **ADRs**: `docs/decisions/` does not exist yet. ~5-7 retroactive ADRs are needed for decisions already taken (LEGACY_PLUGIN_SLUG, two MCP servers, SQLite local, tier-3 Claude Code, etc.)
- **HARNESS-{target}.md per Tier 1/2 target**: one-page summary per target with maintainer, install example, known edge cases

## Compatibility commitments

- The 7 `SUPPORTED_INSTALL_TARGETS` identifiers (`egc`, `cursor`, `antigravity`, `codex`, `gemini`, `opencode`, `codebuddy`) are stable. They will not be renamed within `0.x`
- The Tier 2 install entry points (`.kiro/install.sh`, `.trae/install.sh`) are stable within `0.x`
- The Tier 3 protocol injection target paths (`~/.claude/CLAUDE.md` for Claude Code) are stable within `0.x`
- JSON Schema field names are stable within `MINOR` versions. Removals require a `MAJOR` bump
- Legacy plugin identifiers (`everything-gemini`, `everything-gemini@everything-gemini`) remain resolvable indefinitely via `scripts/lib/resolve-egc-root.js` fallback chain. This is permanent backward compatibility
