# EGC Integration Tiers

> The honest map of how each supported AI coding tool integrates with EGC.

EGC supports 20 AI coding tools through 3 distinct integration mechanisms. This document is the source of truth for what is and is not integrated, and at what depth.

What the maintainers guarantee per tool is a separate axis: see [support levels](../governance/support-levels.md).

## Tier definitions

| Tier | Name | What ships | Install pipeline |
|------|------|------------|------------------|
| **1** | Full unified | Skills, agents, rules, hooks, install manifest | `scripts/install-apply.js` via `SUPPORTED_INSTALL_TARGETS` |
| **2** | Custom-script (retired) | Formerly tool-specific assets via a dedicated shell script | none: Kiro, Trae and CodeBuddy assets ship through their Tier 1 adapters |
| **3** | Protocol-only | MCP server registration + memory protocol injection | `scripts/bootstrap-cognitive.js` + `install.sh` MCP registration |

## The 20 harnesses

> Retired on 2026-08-16, after each vendor's own lifecycle decision: Gemini CLI (standalone product stopped serving 2026-06-18; Antigravity succeeded it on the same home directory), Continue.dev (shut down after the Cursor acqui-hire, repository read-only), and Roo Code (archived upstream since 2026-05-15). Their adapter files remain in the tree, unregistered, for history and trivial rollback.

| # | Tool | Tier | Target id | Install path | Notes |
|---|------|------|-----------|--------------|-------|
| 1 | **Claude Code** | 1 | `claude` | `~/.claude/skills/<name>/SKILL.md`, `~/.claude/agents/<name>.md`, `~/.claude/commands/<name>.md`, `~/.claude/rules/<namespace>-<rule>.md` | Skills installed flat; agents rewritten to the frontmatter Claude Code reads (the tools list as a comma-separated string, a model Claude Code cannot run dropped); commands as slash commands; rules flattened with their `paths` scopes, without `rules/zh` (it mirrors `rules/common` in Chinese and would load into every session); cognitive bootstrap via `~/.claude/CLAUDE.md`. MCP registration happens through Claude Code's own CLI (`claude mcp add -s user`), driven by `egc init` and the shell installers, not by this target (#1193) |
| 2 | **Antigravity (AGY)** | 1 | `antigravity` | `.agents/` (project-scoped, per repo) | Skills, agents, rules, and commands installed per-project; GateGuard hooks registered; no home-level target (Antigravity has no global rule discovery) |
| 3 | **Cursor** | 1 | `cursor` | `~/.cursor/` | Rules injected into global cursor.rules |
| 4 | **Codex CLI** | 1 | `codex` | `~/.agents/skills/<name>/SKILL.md` | Skills installed flat; agents, commands and rules as library folders under `~/.agents/`; `persistent_instructions` appended |
| 5 | **OpenCode** | 1 | `opencode` | `~/.config/opencode/skills/<name>/SKILL.md` | Agents and rules as library folders under `~/.config/opencode/`, commands as before; native plugin events for hooks. MCP registration goes into `~/.config/opencode/opencode.json` (or the legacy `config.json` when only that exists) under the `mcp` key, in OpenCode's own shape (`{ type: "local", command: [...] }`); OpenCode reads that directory on every platform, Windows included, so the target is the same everywhere (#1405). From the repository's `.opencode/` package only `commands`, `instructions` and `prompts` are installed into the config directory, never its TypeScript tools, plugin sources, package files or `opencode.json` (#1396); agents land under `~/.config/opencode/agents/` through a frontmatter transform (tools object, `mode: subagent`, no Gemini model or color), the only shape OpenCode accepts there |
| 6 | **CodeBuddy** | 1 | `codebuddy` | `.codebuddy/skills/<name>/` (project; `egc install --target codebuddy --profile full` run from the home directory writes `~/.codebuddy/`) | Skills flat, agents, commands and namespaced rules via the unified pipeline; the former `.codebuddy/install.sh` and `install.js` are retired |
| 7 | **Windsurf** | 1 | `windsurf` | `~/.codeium/windsurf/skills/<name>/SKILL.md` | Skills installed flat; agents, commands and rules as library folders under `~/.codeium/windsurf/` |
| 8 | **Amp** | 1 | `amp` | `~/.amp/skills/<name>/SKILL.md` | Skills installed flat; agents, commands and rules as library folders under `~/.amp/`; Guardian + Token Crusher wired via Amp's Plugin API (`tool.call` event, `.amp/plugins/` project or `~/.config/amp/plugins/` home -- a genuinely different root than the skills path above), executed in-process by Amp's own Bun runtime, same pattern as OpenCode's plugin |
| 9 | **VS Code Copilot** | 1 | `copilot` | `~/.github/skills/<name>/SKILL.md` | Skills installed flat; agents, commands and rules as library folders under `~/.github/` |
| 10 | **Zed** | 1 | `zed` | `~/.config/zed/skills/<name>/` | Skills installed flat (category stripped); agents, commands and rules as library folders under `~/.config/zed/`; cognitive bootstrap into `~/.config/zed/AGENTS.md`. MCP registration into `context_servers` in `settings.json` is **not** part of this target: like every `--target`, it installs skills and rules only. The MCP servers are registered by `egc init` and by the shell installers, which detect Zed independently (corrected in #1206) |
| 11 | **Kiro** | 1 | `kiro` | `~/.kiro/skills/<name>/` (home) and `.kiro/skills/<name>/` (project) | Skills, agents, commands and rules via the unified pipeline (`~/.kiro/agents`, `~/.kiro/commands`, `~/.kiro/rules`); the Kiro-native agents (JSON and Markdown), steering docs, IDE hooks, scripts and MCP settings example ship from the repository's `.kiro` directory through `platform-configs`; the former `.kiro/install.sh` is retired |
| 12 | **Trae** | 1 | `trae` | `.trae/skills/<name>/` (project; `TRAE_ENV=cn` selects `.trae-cn/`; run `egc install --target trae --profile full` from the home directory for `~/.trae/`) | Skills flat, commands, agents and rules via the unified pipeline, with the Guardian validators in `hooks.json`; the `~/.trae/MEMORY.md` protocol comes from `scripts/bootstrap-cognitive.js`; the former `.trae/install.sh` and `uninstall.sh` are retired |
| 13 | **JetBrains Junie** | 1 | `junie` | `.junie/guidelines.md` | Project guidelines installed via the unified pipeline using JetBrains Junie's native guidelines discovery path; skills, agents, commands and rules as library folders under `~/.junie/` |
| 14 | **Goose** | 1 | `goose` | `~/.agents/skills/<name>/SKILL.md` (shared with Codex) | Skills, agents, commands and rules over the same `~/.agents` root `codex-home.js` already writes to; Guardian wired via a real `PreToolUse` hook (EGC-498 corrected -- confirmed against aaif-goose/goose's own docs and its PR #9304, merged 2026-05-19), format byte-for-byte identical to Claude Code's own settings.json, at a self-contained `~/.agents/plugins/egc-guardian/` root; no Token Crusher (allow/deny only, no rewrite capability documented) |
| 15 | **Amazon Q Developer CLI** | 1 | `amazonq` | `.amazonq/rules/` (project, default target) + `.amazonq/cli-agents/egc-guardian.json` (project and home, id `amazonq-home`) | Rules, agents and commands: default scaffold (category preserved), same passthrough template the retired `gemini-project.js` adapter used. Guardian wired via a real `preToolUse` custom-agent hook (EGC-498 corrected -- confirmed against aws/amazon-q-developer-cli's own docs); not auto-activated by default due to an open upstream bug (aws/amazon-q-developer-cli#2922, `q_cli_default.json` override silently ignored) -- run `q settings chat.defaultAgent egc-guardian` once, or pass `--agent egc-guardian` per session; no Token Crusher |
| 16 | **OpenHands** | 1 | `openhands` | `~/.agents/skills/<name>/SKILL.md` (shared with Codex/Goose, default target) + `.openhands/hooks.json` (project only, id `openhands-project`) | Skills, agents, commands and rules: discoverability-only adapter, same shape as Goose's. Guardian wired via a real `pre_tool_use` hook (EGC-498 corrected -- confirmed against OpenHands/docs' own hooks.mdx), project-scoped only (no global/home path documented); no Token Crusher |
| 17 | **Aider** | 1 | `aider` | `.aider/skills/<name>.md` (project only, no home target) | Skills copied flat as single `.md` files (Aider does not scan a skill-folder convention); each file's path is merged into the `read:` list of `.aider.conf.yml` via a new `merge-yaml-read-list` operation kind, preserving any unrelated existing keys; install/repair/uninstall all wired |
| 18 | **Cline** | 1 | `cline` | `.clinerules/` (project only, no home target) | Rules are flattened into Cline's project-level rules directory using collision-safe namespaced filenames; agents and commands as library folders under `.clinerules/` |
| 19 | **Warp** | 1 | `warp` | `.warp/skills/<name>.md` + index in project root `AGENTS.md` (project only, no home target) | Warp only discovers a single root `AGENTS.md`/`WARP.md` file as project rules, not a directory of skill files -- confirmed a plain `AGENTS.md` is sufficient (Warp's own docs call it the default project rules file; `WARP.md` is legacy and only takes priority if both exist). Full skill content is copied flat to `.warp/skills/<name>.md` (read on demand); a short index (name + one-line description + path) is merged into a marked block inside `AGENTS.md` via a new `merge-markdown-skill-index` operation kind, since concatenating all 230+ skills (~2MB) into the always-loaded rules file would blow the context budget. Install/repair/uninstall all wired; uninstall never deletes `AGENTS.md` itself, only the EGC block |
| 20 | **Qwen Code** | 1 | `qwen` | `.qwen/skills/<name>/SKILL.md` (project only, no home target) | Skills installed flat with the source category stripped; Qwen Code discovers project skills natively from `.qwen/skills/`; agents, commands and rules as library folders under `.qwen/`; no hook wiring |

## Prompt library per target

With `--profile full` every target receives the whole prompt library the README counts (agents, skills, commands, rules), and `egc install --prompt-library` applies that profile to every home target detected on the machine (config directory or command on PATH) and to Trae and CodeBuddy under the home directory through their project adapters. A tool without native discovery for a family still receives the files under its root as a library folder, so the agent can be pointed at them. The documented exceptions: Claude Code leaves the Chinese mirror of the common rules out (they would load into every session), and Aider and Warp receive the memory rule only. The contract test in `tests/lib/install-library-contract.test.js` resolves the full profile on all 21 targets and counts what lands. Codex, Goose and OpenHands share the `~/.agents` root, so the same test resolves the three plans together and fails when any destination has two sources; at a destination the catalog also delivers, the catalog copy wins over the repository's `.agents/skills` mirror, and only what the mirror alone carries (the Codex `openai.yaml` metadata) ships from it.

## Session-mesh delivery per harness

Every harness participates in the real-time session mesh through two always-on layers, plus a native turn signal where the host's own extension surface supports context injection (each claim below was verified against the vendor's current official documentation, or its source code, on 2026-08-16):

1. **MCP bus (all 20):** `session_announce`, `session_events`, `session_send`, `claim_path`, `working_memory_*`, and the long-poll `session_wait` (wake-on-write, ON by default, with a slow stat poll of the store while a waiter is parked as the safety net for a silent watcher; `EGC_MESH_PUSH=0` opts a server out).
2. **Cognitive protocol v7 (all 20):** every install's context file teaches the agent to announce presence after restoring state, drain events when an `[egc-mesh]` notice appears, drain `session_events` at the start of every turn while busy (autonomous-loop ticks and scheduled wakeups included) before deciding to stay silent, claim paths before shared edits, and park with `session_wait` when idle. Since v6 the same block states that the state store belongs to `egc-memory` (encrypted at rest, one file per project and branch), that the agent must never read or write those files directly, and that an agent without `get_state` among its tools should say the server is not registered and point at `egc init` instead of improvising memory on the filesystem. Since v7 the review line sends the agent to the `/review-pr` agents only when the prompt library is installed for the tool, and `orchestrate_task` lists what is not installed.
3. **Native turn signal (hosts with injection-capable surfaces):** the standalone `mesh-events-inject.js` stats the bus store on every user prompt and injects a one-line drain notice.
   - **Claude Code**: `UserPromptSubmit` hook (settings.json).
   - **Antigravity**: same hook at `.agents/hooks.json` (project) and `~/.gemini/antigravity-cli/hooks.json` (global).
   - **Codex CLI**: same hook at `~/.codex/hooks.json` (`additionalContext` documented).
   - **Trae**: same hook at `.trae/hooks.json` (hook stdout becomes model context).
   - **Amp**: `agent.start` plugin at `.amp/plugins/` and `~/.config/amp/plugins/` returning a hidden context message.
   - **Kiro**: dedicated hook document at `.kiro/hooks/egc-mesh-notice.json` (project and home), `UserPromptSubmit` command action whose stdout becomes agent context (`--format=text`).
   - **Not wired, by the host's own limitation** (documented upstream, revisited when vendors ship injection): Cursor (`beforeSubmitPrompt` observes/blocks but does not inject), OpenCode (no per-turn context event), Goose (turn-boundary hook stdout is discarded upstream), and the remaining harnesses whose surfaces expose no per-turn hook (Qwen, Windsurf, VS Code Copilot, Zed, Junie, Amazon Q, OpenHands, Aider, Cline, Warp, CodeBuddy). All of these still get layers 1 and 2.

## Why three tiers (history, not aspiration)

Tier 1 (unified) is the canonical pipeline. It is the result of `install-plan.js` resolving install manifests against `SUPPORTED_INSTALL_TARGETS`, then `install-apply.js` materializing files. The pipeline emits provenance, supports dry-run, and is covered by 200+ tests under `tests/`.

Tier 2 (custom-script) is retired. Kiro and Trae landed in EGC before the unified pipeline was stable and kept shell installers for the assets the pipeline could not shape yet; since the release after 1.1.22 those assets (Kiro's native agents, steering docs, hooks, scripts and settings; Trae's commands, agents and rules) ship through their Tier 1 adapters, with install-state, `egc doctor` and `egc repair`, on Windows too. The `.{tool}/install.sh` scripts and their `.egc-manifest` files are gone; `egc uninstall --target <tool>` removes what the pipeline installed.

Tier 3 (protocol-only) is the entry point for any tool that supports MCP. Claude Code was previously Tier 3, but now supports `~/.claude/skills/<name>/SKILL.md` as a skill discovery path, so it has been promoted to Tier 1 with target id `claude`. Windsurf, Amp, and VS Code Copilot were added as Tier 1 targets in v1.0.2 following the same skill-discovery pattern. Continue.dev followed the same pattern as a later Tier 1 harness until the product's 2026 shutdown retired it (its MCP registration via `~/.continue/mcpServers/` YAML block files had landed separately in #564).

## What "supported" guarantees

For all 20 harnesses, EGC guarantees:

- The install path is documented above
- MCP server registration (if the tool supports MCP)
- Memory protocol injection (the `get_state` / `update_state` instructions reach the AI)
- An uninstall path exists

For Tier 1 only:

- Skills, agents, rules ship to the tool's filesystem
- The tool can invoke EGC-defined workflows directly
- A single pipeline produces all targets
- Conformance tests validate the install output (see `tests/spec/`)
- Provenance metadata is recorded for every materialized file

## Reading the harness-audit output

`node scripts/harness-audit.js` produces a report scored against the 7 categories defined in `CATEGORIES`. The score reflects repo-level health, not per-harness health. A future enhancement is per-harness rollup (see `docs/spec/README.md` Next Steps).

## Adding a new harness

Choose tier based on what the target tool actually consumes:

1. **MCP and instruction files only?** Tier 3. Add MCP registration to `install.sh` and a target name to `scripts/bootstrap-cognitive.js`. ~50 lines of changes.
2. **Filesystem skills/agents/rules + custom layout?** Tier 1 with a custom adapter: plan the tool's layout in `scripts/lib/install-targets/<tool>-*.js` (the Kiro adapters and `scripts/lib/kiro-platform-operations.js` show a tool with assets of its own). No shell script.
3. **Filesystem skills/agents/rules + canonical layout?** Tier 1. Add to `SUPPORTED_INSTALL_TARGETS` in `scripts/lib/install-manifests.js`, define the manifest entries. ~50 lines of config, no new code path.

Tier 1 is the answer for every tool with filesystem assets, whatever their layout; Tier 3 is the right answer for thin clients. Tier 2 is retired.

## Known gaps (audit findings 2026-06-10)

- Kiro's and Trae's assets all ship through Tier 1 since the release after 1.1.22; the `.{tool}/install.sh` scripts are retired
- `harness-audit` scores the repo, not individual harnesses - per-harness rollup is the next maturation step
