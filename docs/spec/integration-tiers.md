# EGC Integration Tiers

> The honest map of how each supported AI coding tool integrates with EGC.

EGC supports 14 AI coding tools through 3 distinct integration mechanisms. This document is the source of truth for what is and is not integrated, and at what depth.

## Tier definitions

| Tier | Name | What ships | Install pipeline |
|------|------|------------|------------------|
| **1** | Full unified | Skills, agents, rules, hooks, MCP, install manifest | `scripts/install-apply.js` via `SUPPORTED_INSTALL_TARGETS` |
| **2** | Custom-script | Tool-specific assets via dedicated installer | `.{tool}/install.sh` called from `install.sh` |
| **3** | Protocol-only | MCP server registration + memory protocol injection | `scripts/bootstrap-cognitive.js` + `install.sh` MCP registration |

## The 14 harnesses

| # | Tool | Tier | Target id | Install path | Notes |
|---|------|------|-----------|--------------|-------|
| 1 | **Claude Code** | 1 | `claude` | `~/.claude/skills/<name>/SKILL.md` | Skills installed flat; MCP + cognitive bootstrap via `~/.claude/CLAUDE.md` |
| 2 | **Antigravity (AGY)** | 1 | `antigravity` | `.agents/` (project-scoped, per repo) | Skills, agents, rules, and commands installed per-project; GateGuard hooks registered; no home-level target (Antigravity has no global rule discovery) |
| 3 | **Gemini CLI** | 1 | `gemini` | `~/.gemini/` | Cognitive bootstrap into `GEMINI.md` |
| 4 | **Cursor** | 1 | `cursor` | `~/.cursor/` | Rules injected into global cursor.rules |
| 5 | **Codex CLI** | 1 | `codex` | `~/.agents/skills/<name>/SKILL.md` | Skills installed flat; `persistent_instructions` appended |
| 6 | **OpenCode** | 1 | `opencode` | `~/.config/opencode/skills/<name>/SKILL.md` | Native plugin events for hooks |
| 7 | **CodeBuddy** | 1 | `codebuddy` | `.codebuddy/skills/<name>/SKILL.md` | Context injection |
| 8 | **Windsurf** | 1 | `windsurf` | `~/.codeium/windsurf/skills/<name>/SKILL.md` | Skills installed flat |
| 9 | **Amp** | 1 | `amp` | `~/.amp/skills/<name>/SKILL.md` | Skills installed flat |
| 10 | **VS Code Copilot** | 1 | `copilot` | `~/.github/skills/<name>/SKILL.md` | Skills installed flat |
| 11 | **Zed** | 1 | `zed` | `~/.config/zed/skills/<name>/` | Skills installed flat (category stripped); MCP via `context_servers` in `settings.json`; cognitive bootstrap into `~/.config/zed/AGENTS.md` |
| 12 | **Continue.dev** | 1 | `continue` | `~/.continue/skills/<name>/SKILL.md` | Skills installed flat; MCP via YAML block files in `~/.continue/mcpServers/`; memory protocol prompt in `~/.continue/prompts/`; rules discovered natively at workspace `.continue/rules/` |
| 13 | **Kiro** | 2 | (none) | `~/.kiro/` via `.kiro/install.sh` | Session hooks installed to `~/.kiro/hooks/` |
| 14 | **Trae** | 2 | (none) | `~/.trae/` (or `~/.trae-cn/` with `TRAE_ENV=cn`) via `.trae/install.sh` | Memory protocol written to `~/.trae/MEMORY.md` |

## Why three tiers (history, not aspiration)

Tier 1 (unified) is the canonical pipeline. It is the result of `install-plan.js` resolving install manifests against `SUPPORTED_INSTALL_TARGETS`, then `install-apply.js` materializing files. The pipeline emits provenance, supports dry-run, and is covered by 200+ tests under `tests/`.

Tier 2 (custom-script) exists because Kiro and Trae landed in EGC before the unified pipeline was stable. Their installers do roughly the same work as the unified pipeline, but the shape of the assets they ship differs enough that retrofitting them is non-trivial. They are first-class but technically isolated.

Tier 3 (protocol-only) is the entry point for any tool that supports MCP. Claude Code was previously Tier 3, but now supports `~/.claude/skills/<name>/SKILL.md` as a skill discovery path, so it has been promoted to Tier 1 with target id `claude`. Windsurf, Amp, and VS Code Copilot were added as Tier 1 targets in v1.0.2 following the same skill-discovery pattern. Continue.dev followed the same pattern as the 14th harness (its MCP registration via `~/.continue/mcpServers/` YAML block files landed separately in #564).

## What "supported" guarantees

For all 14 harnesses, EGC guarantees:

- The install path is documented above
- MCP server registration (if the tool supports MCP)
- Memory protocol injection (the `get_state` / `update_state` instructions reach the AI)
- An uninstall path exists

For Tier 1 and Tier 2 only:

- Skills, agents, rules ship to the tool's filesystem
- The tool can invoke EGC-defined workflows directly

For Tier 1 only:

- A single pipeline produces all targets
- Conformance tests validate the install output (see `tests/spec/`)
- Provenance metadata is recorded for every materialized file

## Reading the harness-audit output

`node scripts/harness-audit.js` produces a report scored against the 7 categories defined in `CATEGORIES`. The score reflects repo-level health, not per-harness health. A future enhancement is per-harness rollup (see `docs/spec/README.md` Next Steps).

## Adding a 15th harness

Choose tier based on what the target tool actually consumes:

1. **MCP and instruction files only?** Tier 3. Add MCP registration to `install.sh` and a target name to `scripts/bootstrap-cognitive.js`. ~50 lines of changes.
2. **Filesystem skills/agents/rules + custom layout?** Tier 2. Create `.{tool}/install.sh` following the Kiro/Trae shape. ~200 lines.
3. **Filesystem skills/agents/rules + canonical layout?** Tier 1. Add to `SUPPORTED_INSTALL_TARGETS` in `scripts/lib/install-manifests.js`, define the manifest entries. ~50 lines of config, no new code path.

Tier 1 is preferred when possible. Tier 2 is acceptable for tools with non-standard asset layouts. Tier 3 is the right answer for thin clients.

## Known gaps (audit findings 2026-06-10)

- Kiro and Trae are Tier 2 because they predate the unified pipeline. They could be migrated to Tier 1 with ~6-8h of work each
- `harness-audit` scores the repo, not individual harnesses - per-harness rollup is the next maturation step
