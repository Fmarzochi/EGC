# EGC Integration Tiers

> The honest map of how each supported AI coding tool integrates with EGC.

EGC supports 9 AI coding tools through 3 distinct integration mechanisms. This document is the source of truth for what is and is not integrated, and at what depth.

## Tier definitions

| Tier | Name | What ships | Install pipeline |
|------|------|------------|------------------|
| **1** | Full unified | Skills, agents, rules, hooks, MCP, install manifest | `scripts/install-apply.js` via `SUPPORTED_INSTALL_TARGETS` |
| **2** | Custom-script | Tool-specific assets via dedicated installer | `.{tool}/install.sh` called from `install.sh` |
| **3** | Protocol-only | MCP server registration + memory protocol injection | `scripts/bootstrap-cognitive.js` + `install.sh` MCP registration |

## The 9 harnesses

| # | Tool | Tier | Target id | Install path | Notes |
|---|------|------|-----------|--------------|-------|
| 1 | **Claude Code** | 3 | (none) | `~/.claude/CLAUDE.md` + `~/.claude/claude_desktop_config.json` | MCP-only + cognitive bootstrap. No skill/agent copy |
| 2 | **Antigravity (AGY)** | 1 | `antigravity` | `~/.gemini/` (shared with Gemini CLI) | Reuses GEMINI.md from Gemini CLI |
| 3 | **Gemini CLI** | 1 | `gemini` | `~/.gemini/` | Cognitive bootstrap into `GEMINI.md` |
| 4 | **Cursor** | 1 | `cursor` | `~/.cursor/` | Rules injected into global cursor.rules |
| 5 | **Codex CLI** | 1 | `codex` | `~/.codex/config.toml` | `persistent_instructions` appended |
| 6 | **OpenCode** | 1 | `opencode` | `~/.opencode/instructions/EGC_MEMORY.md` | Native plugin events for hooks |
| 7 | **CodeBuddy** | 1 | `codebuddy` | `~/.codebuddy/MEMORY.md` | Context injection |
| 8 | **Kiro** | 2 | (none) | `~/.kiro/` via `.kiro/install.sh` | Session hooks installed to `~/.kiro/hooks/` |
| 9 | **Trae** | 2 | (none) | `~/.trae/` (or `~/.trae-cn/` with `TRAE_ENV=cn`) via `.trae/install.sh` | Memory protocol written to `~/.trae/MEMORY.md` |

## Why three tiers (history, not aspiration)

Tier 1 (unified) is the canonical pipeline. It is the result of `install-plan.js` resolving install manifests against `SUPPORTED_INSTALL_TARGETS`, then `install-apply.js` materializing files. The pipeline emits provenance, supports dry-run, and is covered by 200+ tests under `tests/`.

Tier 2 (custom-script) exists because Kiro and Trae landed in EGC before the unified pipeline was stable. Their installers do roughly the same work as the unified pipeline, but the shape of the assets they ship differs enough that retrofitting them is non-trivial. They are first-class but technically isolated.

Tier 3 (protocol-only) is the entry point for any tool that supports MCP. Claude Code sits here because the use case is "AI tool reads `CLAUDE.md` and connects to MCP servers" - copying skills into Claude Code's filesystem would not be useful since Claude Code does not run them. The protocol bootstrap is enough.

## What "supported" guarantees

For all 9 harnesses, EGC guarantees:

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

## Adding a 10th harness

Choose tier based on what the target tool actually consumes:

1. **MCP and instruction files only?** Tier 3. Add MCP registration to `install.sh` and a target name to `scripts/bootstrap-cognitive.js`. ~50 lines of changes.
2. **Filesystem skills/agents/rules + custom layout?** Tier 2. Create `.{tool}/install.sh` following the Kiro/Trae shape. ~200 lines.
3. **Filesystem skills/agents/rules + canonical layout?** Tier 1. Add to `SUPPORTED_INSTALL_TARGETS` in `scripts/lib/install-manifests.js`, define the manifest entries. ~50 lines of config, no new code path.

Tier 1 is preferred when possible. Tier 2 is acceptable for tools with non-standard asset layouts. Tier 3 is the right answer for thin clients.

## Known gaps (audit findings 2026-06-05)

- Kiro and Trae are Tier 2 because they predate the unified pipeline. They could be migrated to Tier 1 with ~6-8h of work each
- Claude Code is Tier 3 because no skill/agent file copy is necessary for the use case. This is intentional
- `harness-audit` scores the repo, not individual harnesses - per-harness rollup is the next maturation step
