# EGC Integration Tiers

> The honest map of how each supported AI coding tool integrates with EGC.

EGC supports 20 AI coding tools through 3 distinct integration mechanisms. This document is the source of truth for what is and is not integrated, and at what depth.

## Tier definitions

| Tier | Name | What ships | Install pipeline |
|------|------|------------|------------------|
| **1** | Full unified | Skills, agents, rules, hooks, MCP, install manifest | `scripts/install-apply.js` via `SUPPORTED_INSTALL_TARGETS` |
| **2** | Custom-script | Tool-specific assets via dedicated installer | `.{tool}/install.sh` called from `install.sh` |
| **3** | Protocol-only | MCP server registration + memory protocol injection | `scripts/bootstrap-cognitive.js` + `install.sh` MCP registration |

## The 20 harnesses

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
| 13 | **Kiro** | 1 | `kiro` | `~/.kiro/skills/<name>/` (home) and `.kiro/skills/<name>/` (project) | Skills installed flat via the unified pipeline; the legacy `.kiro/install.sh` script still handles project-local agents, steering docs, hooks, scripts, and settings (a separate concern from skill distribution, not yet migrated) |
| 14 | **Trae** | 1 | `trae` | `.trae/skills/<name>/` (project only, no home target) | Skills installed flat via the unified pipeline; the legacy `.trae/install.sh` script still handles commands, agents, rules, and the `~/.trae/MEMORY.md` memory protocol (project-scoped only; `TRAE_ENV=cn` for `~/.trae-cn/`) |
| 15 | **JetBrains Junie** | 1 | `junie` | `.junie/guidelines.md` | Project guidelines installed via the unified pipeline using JetBrains Junie's native guidelines discovery path |
| 16 | **Goose** | 1 | `goose` | `~/.agents/skills/<name>/SKILL.md` (shared with Codex) | Skills installed flat; no GateGuard hook wiring (Goose has no documented hook API); discoverability-only adapter over the same `~/.agents` root `codex-home.js` already writes to |
| 17 | **Amazon Q Developer CLI** | 1 | `amazonq` | `.amazonq/rules/` (project only, no home target) | Default scaffold (category preserved), same template as `gemini-project.js`; no hook wiring |
| 18 | **Roo Code** | 1 | `roocode` | `.roo/rules/` (project only, no home target) | Default scaffold with category structure preserved; Roo Code recursively discovers project rules from `.roo/rules/`; no hook wiring |
| 19 | **OpenHands** | 1 | `openhands` | `~/.agents/skills/<name>/SKILL.md` (shared with Codex/Goose) | Skills installed flat; no GateGuard hook wiring; discoverability-only adapter -- the issue asked for `.openhands/microagents/`, but current OpenHands docs recommend the AgentSkills-standard `.agents/skills/<name>/SKILL.md` path (legacy `.openhands/microagents/` still works but isn't the documented target), so this mirrors the Goose adapter instead |
| 20 | **Aider** | 1 | `aider` | `.aider/skills/<name>.md` (project only, no home target) | Skills copied flat as single `.md` files (Aider does not scan a skill-folder convention); each file's path is merged into the `read:` list of `.aider.conf.yml` via a new `merge-yaml-read-list` operation kind, preserving any unrelated existing keys; install/repair/uninstall all wired |
| 21 | **Warp** | 1 | `warp` | `.warp/skills/<name>.md` + index in project root `AGENTS.md` (project only, no home target) | Warp only discovers a single root `AGENTS.md`/`WARP.md` file as project rules, not a directory of skill files -- confirmed a plain `AGENTS.md` is sufficient (Warp's own docs call it the default project rules file; `WARP.md` is legacy and only takes priority if both exist). Full skill content is copied flat to `.warp/skills/<name>.md` (read on demand); a short index (name + one-line description + path) is merged into a marked block inside `AGENTS.md` via a new `merge-markdown-skill-index` operation kind, since concatenating all 230+ skills (~2MB) into the always-loaded rules file would blow the context budget. Install/repair/uninstall all wired; uninstall never deletes `AGENTS.md` itself, only the EGC block |

## Why three tiers (history, not aspiration)

Tier 1 (unified) is the canonical pipeline. It is the result of `install-plan.js` resolving install manifests against `SUPPORTED_INSTALL_TARGETS`, then `install-apply.js` materializing files. The pipeline emits provenance, supports dry-run, and is covered by 200+ tests under `tests/`.

Tier 2 (custom-script) exists because Kiro and Trae landed in EGC before the unified pipeline was stable. Their installers do roughly the same work as the unified pipeline, but the shape of the assets they ship differs enough that retrofitting them is non-trivial. They are first-class but technically isolated. Both Kiro's and Trae's skill distribution have since been migrated to Tier 1 (target ids `kiro` and `trae`); their non-skill assets (Kiro: agents/steering/hooks/settings; Trae: commands/agents/rules/memory protocol) still ship through their original `.{tool}/install.sh` scripts.

Tier 3 (protocol-only) is the entry point for any tool that supports MCP. Claude Code was previously Tier 3, but now supports `~/.claude/skills/<name>/SKILL.md` as a skill discovery path, so it has been promoted to Tier 1 with target id `claude`. Windsurf, Amp, and VS Code Copilot were added as Tier 1 targets in v1.0.2 following the same skill-discovery pattern. Continue.dev followed the same pattern as a later Tier 1 harness (its MCP registration via `~/.continue/mcpServers/` YAML block files landed separately in #564).

## What "supported" guarantees

For all 21 harnesses, EGC guarantees:

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

## Adding a new harness

Choose tier based on what the target tool actually consumes:

1. **MCP and instruction files only?** Tier 3. Add MCP registration to `install.sh` and a target name to `scripts/bootstrap-cognitive.js`. ~50 lines of changes.
2. **Filesystem skills/agents/rules + custom layout?** Tier 2. Create `.{tool}/install.sh` following the Kiro/Trae shape. ~200 lines.
3. **Filesystem skills/agents/rules + canonical layout?** Tier 1. Add to `SUPPORTED_INSTALL_TARGETS` in `scripts/lib/install-manifests.js`, define the manifest entries. ~50 lines of config, no new code path.

Tier 1 is preferred when possible. Tier 2 is acceptable for tools with non-standard asset layouts. Tier 3 is the right answer for thin clients.

## Known gaps (audit findings 2026-06-10)

- Both Kiro's and Trae's skill distribution moved to Tier 1 (see rows 13-14); each tool's non-skill assets remain on its legacy `.{tool}/install.sh` path
- `harness-audit` scores the repo, not individual harnesses - per-harness rollup is the next maturation step
