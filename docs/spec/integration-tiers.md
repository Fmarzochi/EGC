# EGC Integration Tiers

> The honest map of how each supported AI coding tool integrates with EGC.

EGC supports 20 AI coding tools through 3 distinct integration mechanisms. This document is the source of truth for what is and is not integrated, and at what depth.

## Tier definitions

| Tier | Name | What ships | Install pipeline |
|------|------|------------|------------------|
| **1** | Full unified | Skills, agents, rules, hooks, install manifest | `scripts/install-apply.js` via `SUPPORTED_INSTALL_TARGETS` |
| **2** | Custom-script | Tool-specific assets via dedicated installer | `.{tool}/install.sh` called from `install.sh` |
| **3** | Protocol-only | MCP server registration + memory protocol injection | `scripts/bootstrap-cognitive.js` + `install.sh` MCP registration |

## The 20 harnesses

> Retired on 2026-08-16, after each vendor's own lifecycle decision: Gemini CLI (standalone product stopped serving 2026-06-18; Antigravity succeeded it on the same home directory), Continue.dev (shut down after the Cursor acqui-hire, repository read-only), and Roo Code (archived upstream since 2026-05-15). Their adapter files remain in the tree, unregistered, for history and trivial rollback.

| # | Tool | Tier | Target id | Install path | Notes |
|---|------|------|-----------|--------------|-------|
| 1 | **Claude Code** | 1 | `claude` | `~/.claude/skills/<name>/SKILL.md` | Skills installed flat; cognitive bootstrap via `~/.claude/CLAUDE.md`. MCP registration happens through Claude Code's own CLI (`claude mcp add -s user`), driven by `egc init` and the shell installers, not by this target (#1193) |
| 2 | **Antigravity (AGY)** | 1 | `antigravity` | `.agents/` (project-scoped, per repo) | Skills, agents, rules, and commands installed per-project; GateGuard hooks registered; no home-level target (Antigravity has no global rule discovery) |
| 3 | **Cursor** | 1 | `cursor` | `~/.cursor/` | Rules injected into global cursor.rules |
| 4 | **Codex CLI** | 1 | `codex` | `~/.agents/skills/<name>/SKILL.md` | Skills installed flat; `persistent_instructions` appended |
| 5 | **OpenCode** | 1 | `opencode` | `~/.config/opencode/skills/<name>/SKILL.md` | Native plugin events for hooks |
| 6 | **CodeBuddy** | 1 | `codebuddy` | `.codebuddy/skills/<name>/SKILL.md` | Context injection |
| 7 | **Windsurf** | 1 | `windsurf` | `~/.codeium/windsurf/skills/<name>/SKILL.md` | Skills installed flat |
| 8 | **Amp** | 1 | `amp` | `~/.amp/skills/<name>/SKILL.md` | Skills installed flat; Guardian + Token Crusher wired via Amp's Plugin API (`tool.call` event, `.amp/plugins/` project or `~/.config/amp/plugins/` home -- a genuinely different root than the skills path above), executed in-process by Amp's own Bun runtime, same pattern as OpenCode's plugin |
| 9 | **VS Code Copilot** | 1 | `copilot` | `~/.github/skills/<name>/SKILL.md` | Skills installed flat |
| 10 | **Zed** | 1 | `zed` | `~/.config/zed/skills/<name>/` | Skills installed flat (category stripped); cognitive bootstrap into `~/.config/zed/AGENTS.md`. MCP registration into `context_servers` in `settings.json` is **not** part of this target: like every `--target`, it installs skills and rules only. The MCP servers are registered by `egc init` and by the shell installers, which detect Zed independently (corrected in #1206) |
| 11 | **Kiro** | 1 | `kiro` | `~/.kiro/skills/<name>/` (home) and `.kiro/skills/<name>/` (project) | Skills installed flat via the unified pipeline; the legacy `.kiro/install.sh` script still handles project-local agents, steering docs, hooks, scripts, and settings (a separate concern from skill distribution, not yet migrated) |
| 12 | **Trae** | 1 | `trae` | `.trae/skills/<name>/` (project only, no home target) | Skills installed flat via the unified pipeline; the legacy `.trae/install.sh` script still handles commands, agents, rules, and the `~/.trae/MEMORY.md` memory protocol (project-scoped only; `TRAE_ENV=cn` for `~/.trae-cn/`) |
| 13 | **JetBrains Junie** | 1 | `junie` | `.junie/guidelines.md` | Project guidelines installed via the unified pipeline using JetBrains Junie's native guidelines discovery path |
| 14 | **Goose** | 1 | `goose` | `~/.agents/skills/<name>/SKILL.md` (shared with Codex) | Skills installed flat over the same `~/.agents` root `codex-home.js` already writes to; Guardian wired via a real `PreToolUse` hook (EGC-498 corrected -- confirmed against aaif-goose/goose's own docs and its PR #9304, merged 2026-05-19), format byte-for-byte identical to Claude Code's own settings.json, at a self-contained `~/.agents/plugins/egc-guardian/` root; no Token Crusher (allow/deny only, no rewrite capability documented) |
| 15 | **Amazon Q Developer CLI** | 1 | `amazonq` | `.amazonq/rules/` (project, default target) + `.amazonq/cli-agents/egc-guardian.json` (project and home, id `amazonq-home`) | Rules: default scaffold (category preserved), same passthrough template the retired `gemini-project.js` adapter used. Guardian wired via a real `preToolUse` custom-agent hook (EGC-498 corrected -- confirmed against aws/amazon-q-developer-cli's own docs); not auto-activated by default due to an open upstream bug (aws/amazon-q-developer-cli#2922, `q_cli_default.json` override silently ignored) -- run `q settings chat.defaultAgent egc-guardian` once, or pass `--agent egc-guardian` per session; no Token Crusher |
| 16 | **OpenHands** | 1 | `openhands` | `~/.agents/skills/<name>/SKILL.md` (shared with Codex/Goose, default target) + `.openhands/hooks.json` (project only, id `openhands-project`) | Skills: discoverability-only adapter, same shape as Goose's. Guardian wired via a real `pre_tool_use` hook (EGC-498 corrected -- confirmed against OpenHands/docs' own hooks.mdx), project-scoped only (no global/home path documented); no Token Crusher |
| 17 | **Aider** | 1 | `aider` | `.aider/skills/<name>.md` (project only, no home target) | Skills copied flat as single `.md` files (Aider does not scan a skill-folder convention); each file's path is merged into the `read:` list of `.aider.conf.yml` via a new `merge-yaml-read-list` operation kind, preserving any unrelated existing keys; install/repair/uninstall all wired |
| 18 | **Cline** | 1 | `cline` | `.clinerules/` (project only, no home target) | Rules are flattened into Cline's project-level rules directory using collision-safe namespaced filenames |
| 19 | **Warp** | 1 | `warp` | `.warp/skills/<name>.md` + index in project root `AGENTS.md` (project only, no home target) | Warp only discovers a single root `AGENTS.md`/`WARP.md` file as project rules, not a directory of skill files -- confirmed a plain `AGENTS.md` is sufficient (Warp's own docs call it the default project rules file; `WARP.md` is legacy and only takes priority if both exist). Full skill content is copied flat to `.warp/skills/<name>.md` (read on demand); a short index (name + one-line description + path) is merged into a marked block inside `AGENTS.md` via a new `merge-markdown-skill-index` operation kind, since concatenating all 230+ skills (~2MB) into the always-loaded rules file would blow the context budget. Install/repair/uninstall all wired; uninstall never deletes `AGENTS.md` itself, only the EGC block |
| 20 | **Qwen Code** | 1 | `qwen` | `.qwen/skills/<name>/SKILL.md` (project only, no home target) | Skills installed flat with the source category stripped; Qwen Code discovers project skills natively from `.qwen/skills/`; no hook wiring |

## Session-mesh delivery per harness

Every harness participates in the real-time session mesh through two always-on layers, plus a native turn signal where the host's own extension surface supports context injection (each claim below was verified against the vendor's current official documentation, or its source code, on 2026-08-16):

1. **MCP bus (all 20):** `session_announce`, `session_events`, `session_send`, `claim_path`, `working_memory_*`, and the long-poll `session_wait` (wake-on-write, ON by default; `EGC_MESH_PUSH=0` opts a server out).
2. **Cognitive protocol v3 (all 20):** every install's context file teaches the agent to announce presence after restoring state, drain events when an `[egc-mesh]` notice appears, claim paths before shared edits, and park with `session_wait` when idle.
3. **Native turn signal (hosts with injection-capable surfaces):** the standalone `mesh-events-inject.js` stats the bus store on every user prompt and injects a one-line drain notice.
   - **Claude Code**: `UserPromptSubmit` hook (settings.json).
   - **Antigravity**: same hook at `.agents/hooks.json` (project) and `~/.gemini/antigravity-cli/hooks.json` (global).
   - **Codex CLI**: same hook at `~/.codex/hooks.json` (`additionalContext` documented).
   - **Trae**: same hook at `.trae/hooks.json` (hook stdout becomes model context).
   - **Amp**: `agent.start` plugin at `.amp/plugins/` and `~/.config/amp/plugins/` returning a hidden context message.
   - **Not wired, by the host's own limitation** (documented upstream, revisited when vendors ship injection): Cursor (`beforeSubmitPrompt` observes/blocks but does not inject), OpenCode (no per-turn context event), Goose (turn-boundary hook stdout is discarded upstream), Kiro (IDE hooks inject but the CLI agent-config surface this repo integrates has confirmed upstream inconsistencies), and the remaining harnesses whose surfaces expose no per-turn hook (Qwen, Windsurf, VS Code Copilot, Zed, Junie, Amazon Q, OpenHands, Aider, Cline, Warp, CodeBuddy). All of these still get layers 1 and 2.

## Why three tiers (history, not aspiration)

Tier 1 (unified) is the canonical pipeline. It is the result of `install-plan.js` resolving install manifests against `SUPPORTED_INSTALL_TARGETS`, then `install-apply.js` materializing files. The pipeline emits provenance, supports dry-run, and is covered by 200+ tests under `tests/`.

Tier 2 (custom-script) exists because Kiro and Trae landed in EGC before the unified pipeline was stable. Their installers do roughly the same work as the unified pipeline, but the shape of the assets they ship differs enough that retrofitting them is non-trivial. They are first-class but technically isolated. Both Kiro's and Trae's skill distribution have since been migrated to Tier 1 (target ids `kiro` and `trae`); their non-skill assets (Kiro: agents/steering/hooks/settings; Trae: commands/agents/rules/memory protocol) still ship through their original `.{tool}/install.sh` scripts.

Tier 3 (protocol-only) is the entry point for any tool that supports MCP. Claude Code was previously Tier 3, but now supports `~/.claude/skills/<name>/SKILL.md` as a skill discovery path, so it has been promoted to Tier 1 with target id `claude`. Windsurf, Amp, and VS Code Copilot were added as Tier 1 targets in v1.0.2 following the same skill-discovery pattern. Continue.dev followed the same pattern as a later Tier 1 harness until the product's 2026 shutdown retired it (its MCP registration via `~/.continue/mcpServers/` YAML block files had landed separately in #564).

## What "supported" guarantees

For all 20 harnesses, EGC guarantees:

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

- Both Kiro's and Trae's skill distribution moved to Tier 1 (see rows 11-12); each tool's non-skill assets remain on its legacy `.{tool}/install.sh` path
- `harness-audit` scores the repo, not individual harnesses - per-harness rollup is the next maturation step
