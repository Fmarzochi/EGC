# Install paths per tool

Generated from `manifests/tool-paths.json` by `node scripts/ci/generate-tool-paths-doc.js`; edit the table, not this file. `tests/ci/tool-paths-contract.test.js` plans every install target in every variant below and fails when a planned path is missing from the table or a row of the table matches no planned path. Sources checked on 2026-10-10.

Status: **documented** paths are read by the tool per the linked docs; **egc** paths are files of EGC itself under the tool root (hook scripts, install state, library copies the tool does not load); **unverified** paths are planned today but not confirmed by the tool's current docs, with the reason in the note.

## Variants

| Variant | Platform | Environment | Adapters |
| --- | --- | --- | --- |
| default | linux | none | all |
| win32 | win32 | none | windsurf-home |
| XDG_CONFIG_HOME | linux | `XDG_CONFIG_HOME=$XDG_CONFIG_HOME` | crush-home |
| CRUSH_GLOBAL_CONFIG | linux | `CRUSH_GLOBAL_CONFIG=$CRUSH_GLOBAL_CONFIG` | crush-home |
| KIMI_CODE_HOME | linux | `KIMI_CODE_HOME=$KIMI_CODE_HOME` | kimi-home |
| TRAE_ENV=cn | linux | `TRAE_ENV=cn` | trae-project |

## egc-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| context | `~/.gemini/AGENTS.md` | default | documented | <https://antigravity.google/docs/rules> |  |
| agents | `~/.gemini/config/agents/` | default | documented | <https://antigravity.google/docs/subagents> |  |
| hooks | `~/.gemini/config/hooks.json` | default | documented | <https://antigravity.google/docs/hooks> |  |
| rules | `~/.gemini/config/rules/` | default | documented | <https://antigravity.google/docs/rules> |  |
| skills | `~/.gemini/config/skills/` | default | documented | <https://antigravity.google/docs/skills> |  |
| runtime | `~/.gemini/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |

## claude-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| agents | `~/.claude/agents/` | default | documented | <https://docs.anthropic.com/en/docs/claude-code/sub-agents> |  |
| commands | `~/.claude/commands/` | default | documented | <https://docs.anthropic.com/en/docs/claude-code/slash-commands> |  |
| runtime | `~/.claude/egc/` | default | egc |  | EGC runtime: install state and support files EGC reads. |
| runtime | `~/.claude/hooks/` | default | egc |  | EGC runtime: hook scripts the hook configuration of the tool points at. |
| rules | `~/.claude/rules/` | default | documented | <https://docs.anthropic.com/en/docs/claude-code/memory> |  |
| runtime | `~/.claude/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| settings | `~/.claude/settings.json` | default | documented | <https://docs.anthropic.com/en/docs/claude-code/settings> |  |
| skills | `~/.claude/skills/` | default | documented | <https://docs.anthropic.com/en/docs/claude-code/skills> |  |

## cursor-project

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| library | `<project>/.cursor/.agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| agents | `<project>/.cursor/agents/` | default | documented | <https://cursor.com/docs/context/subagents> |  |
| commands | `<project>/.cursor/commands/` | default | unverified | <https://cursor.com/docs/context/skills> | Cursor's current docs no longer describe custom commands in .cursor/commands; the skills page talks about moving commands to skills (read on 2026-10-10). |
| runtime | `<project>/.cursor/hooks/` | default | egc |  | EGC runtime: hook scripts the hook configuration of the tool points at. |
| hooks | `<project>/.cursor/hooks.json` | default | documented | <https://cursor.com/docs/agent/hooks> |  |
| library | `<project>/.cursor/mcp-configs/` | default | egc |  | EGC library: platform configuration sources copied for reference; the tool does not load this path. |
| mcp | `<project>/.cursor/mcp.json` | default | documented | <https://cursor.com/docs/context/mcp> |  |
| rules | `<project>/.cursor/rules/` | default | documented | <https://cursor.com/docs/context/rules> |  |
| runtime | `<project>/.cursor/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| skills | `<project>/.cursor/skills/` | default | documented | <https://cursor.com/docs/context/skills> |  |

## antigravity-project

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| library | `<project>/.agents/.agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| context | `<project>/.agents/AGENTS.md` | default | documented | <https://antigravity.google/docs/rules> |  |
| agents | `<project>/.agents/agents/` | default | documented | <https://antigravity.google/docs/subagents> |  |
| hooks | `<project>/.agents/hooks.json` | default | documented | <https://antigravity.google/docs/hooks> |  |
| rules | `<project>/.agents/rules/` | default | documented | <https://antigravity.google/docs/rules> |  |
| runtime | `<project>/.agents/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| skills | `<project>/.agents/skills/` | default | documented | <https://antigravity.google/docs/skills> |  |

## auggie-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| agents | `~/.augment/agents/` | default | documented | <https://docs.augmentcode.com/cli/subagents> |  |
| commands | `~/.augment/commands/` | default | documented | <https://docs.augmentcode.com/cli/custom-commands> |  |
| rules | `~/.augment/rules/` | default | documented | <https://docs.augmentcode.com/cli/rules> |  |
| skills | `~/.augment/skills/` | default | documented | <https://docs.augmentcode.com/cli/skills> |  |

## auggie-project

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| agents | `<project>/.augment/agents/` | default | documented | <https://docs.augmentcode.com/cli/subagents> |  |
| commands | `<project>/.augment/commands/` | default | documented | <https://docs.augmentcode.com/cli/custom-commands> |  |
| rules | `<project>/.augment/rules/` | default | documented | <https://docs.augmentcode.com/cli/rules> |  |
| skills | `<project>/.augment/skills/` | default | documented | <https://docs.augmentcode.com/cli/skills> |  |

## aider-project

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| config | `<project>/.aider.conf.yml` | default | documented | <https://aider.chat/docs/config/aider_conf.html> |  |
| rules | `<project>/.aider/rules/` | default | documented | <https://aider.chat/docs/config/aider_conf.html> | Loaded through the read list EGC writes in .aider.conf.yml. |
| skills | `<project>/.aider/skills/` | default | documented | <https://aider.chat/docs/config/aider_conf.html> | Loaded through the read list EGC writes in .aider.conf.yml. |

## codex-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| library | `~/.agents` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.agents/.codex/` | default | egc |  | EGC library: platform configuration sources copied for reference; the tool does not load this path. |
| context | `~/.agents/AGENTS.md` | default | unverified | <https://learn.chatgpt.com/docs/agent-configuration/agents-md> | Codex reads AGENTS.md from CODEX_HOME (~/.codex) and from the project, not from ~/.agents (read on 2026-10-10). |
| library | `~/.agents/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.agents/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.agents/mcp-configs/` | default | egc |  | EGC library: platform configuration sources copied for reference; the tool does not load this path. |
| library | `~/.agents/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `~/.agents/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| skills | `~/.agents/skills/` | default | documented | <https://learn.chatgpt.com/codex/skills> |  |
| hooks | `~/.codex/hooks.json` | default | documented | <https://learn.chatgpt.com/docs/hooks> |  |
| runtime | `~/.codex/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |

## goose-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| library | `~/.agents/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.agents/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| hooks | `~/.agents/plugins/egc-guardian/hooks/hooks.json` | default | documented | <https://goose-docs.ai/docs/guides/context-engineering/hooks> |  |
| runtime | `~/.agents/plugins/egc-guardian/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| library | `~/.agents/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| skills | `~/.agents/skills/` | default | documented | <https://goose-docs.ai/docs/guides/context-engineering/using-skills> |  |

## openhands-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| library | `~/.agents/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.agents/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.agents/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| skills | `~/.agents/skills/` | default | documented | <https://docs.openhands.dev/overview/skills> |  |

## openhands-project

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| hooks | `<project>/.openhands/hooks.json` | default | documented | <https://docs.openhands.dev/openhands/usage/customization/hooks> |  |
| runtime | `<project>/.openhands/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |

## qwen-project

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| agents | `<project>/.qwen/agents/` | default | documented | <https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/> |  |
| commands | `<project>/.qwen/commands/` | default | documented | <https://qwenlm.github.io/qwen-code-docs/en/users/features/commands/> |  |
| library | `<project>/.qwen/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `<project>/.qwen/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| hooks | `<project>/.qwen/settings.json` | default | documented | <https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/> |  |
| skills | `<project>/.qwen/skills/` | default | documented | <https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/> |  |

## opencode-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| agents | `~/.config/opencode/agents/` | default | documented | <https://opencode.ai/docs/agents/> |  |
| commands | `~/.config/opencode/commands/` | default | documented | <https://opencode.ai/docs/commands/> |  |
| runtime | `~/.config/opencode/hooks/` | default | egc |  | EGC runtime: hook scripts the hook configuration of the tool points at. |
| library | `~/.config/opencode/instructions/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.config/opencode/mcp-configs/` | default | egc |  | EGC library: platform configuration sources copied for reference; the tool does not load this path. |
| plugins | `~/.config/opencode/plugins/` | default | documented | <https://opencode.ai/docs/plugins/> |  |
| library | `~/.config/opencode/prompts/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.config/opencode/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `~/.config/opencode/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| skills | `~/.config/opencode/skills/` | default | documented | <https://opencode.ai/docs/skills/> |  |

## codebuddy-project

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| library | `<project>/.codebuddy/.agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| context | `<project>/.codebuddy/AGENTS.md` | default | unverified | <https://www.codebuddy.ai/docs/cli/memory> | CodeBuddy's memory docs list CODEBUDDY.md and .codebuddy/rules, not .codebuddy/AGENTS.md (read on 2026-10-10). |
| agents | `<project>/.codebuddy/agents/` | default | documented | <https://www.codebuddy.ai/docs/cli/sub-agents> |  |
| commands | `<project>/.codebuddy/commands/` | default | documented | <https://www.codebuddy.ai/docs/cli/slash-commands> |  |
| runtime | `<project>/.codebuddy/hooks/` | default | egc |  | EGC runtime: hook scripts the hook configuration of the tool points at. |
| library | `<project>/.codebuddy/mcp-configs/` | default | egc |  | EGC library: platform configuration sources copied for reference; the tool does not load this path. |
| rules | `<project>/.codebuddy/rules/` | default | documented | <https://www.codebuddy.ai/docs/cli/memory> |  |
| runtime | `<project>/.codebuddy/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| settings | `<project>/.codebuddy/settings.json` | default | documented | <https://www.codebuddy.ai/docs/cli/settings> |  |
| skills | `<project>/.codebuddy/skills/` | default | documented | <https://www.codebuddy.ai/docs/cli/skills> |  |

## cline-project

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| rules | `<project>/.clinerules/` | default | documented | <https://docs.cline.bot/customization/cline-rules> |  |
| library | `<project>/.clinerules/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `<project>/.clinerules/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| hooks | `<project>/.clinerules/hooks/` | default | unverified | <https://docs.cline.bot/customization/hooks> | Cline's current docs move hooks to SDK plugins and no longer name .clinerules/hooks (read on 2026-10-10). |
| runtime | `<project>/.clinerules/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| skills | `<project>/.clinerules/skills/` | default | documented | <https://docs.cline.bot/customization/skills> |  |

## kiro-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| agents | `~/.kiro/agents/` | default | documented | <https://kiro.dev/docs/custom-agents/creating/> |  |
| library | `~/.kiro/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| hooks | `~/.kiro/hooks/` | default | documented | <https://kiro.dev/docs/hooks/> |  |
| library | `~/.kiro/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `~/.kiro/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| mcp | `~/.kiro/settings/` | default | documented | <https://kiro.dev/docs/mcp/configuration/> |  |
| skills | `~/.kiro/skills/` | default | documented | <https://kiro.dev/docs/skills/> |  |
| steering | `~/.kiro/steering/` | default | documented | <https://kiro.dev/docs/steering/> |  |

## kiro-project

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| agents | `<project>/.kiro/agents/` | default | documented | <https://kiro.dev/docs/custom-agents/creating/> |  |
| library | `<project>/.kiro/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| hooks | `<project>/.kiro/hooks/` | default | documented | <https://kiro.dev/docs/hooks/> |  |
| library | `<project>/.kiro/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `<project>/.kiro/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| mcp | `<project>/.kiro/settings/` | default | documented | <https://kiro.dev/docs/mcp/configuration/> |  |
| skills | `<project>/.kiro/skills/` | default | documented | <https://kiro.dev/docs/skills/> |  |
| steering | `<project>/.kiro/steering/` | default | documented | <https://kiro.dev/docs/steering/> |  |

## windsurf-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| library | `~/.codeium/windsurf/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.codeium/windsurf/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.codeium/windsurf/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `~/.codeium/windsurf/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| skills | `~/.codeium/windsurf/skills/` | default | documented | <https://docs.devin.ai/desktop/cascade/skills> |  |
| hooks | `~/.config/devin/config.json` | default | documented | <https://docs.devin.ai/cli/extensibility/hooks> |  |
| hooks | `~/AppData/Roaming/devin/config.json` | win32 | documented | <https://docs.devin.ai/cli/extensibility/hooks> |  |

## windsurf-project

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| library | `<project>/.devin/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `<project>/.devin/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| hooks | `<project>/.devin/config.local.json` | default | documented | <https://docs.devin.ai/cli/extensibility/hooks> |  |
| library | `<project>/.devin/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `<project>/.devin/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| skills | `<project>/.devin/skills/` | default | documented | <https://docs.devin.ai/desktop/cascade/skills> |  |

## amp-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| skills | `~/.agents/skills/` | default | documented | <https://ampcode.com/docs/customize/skills> |  |
| library | `~/.amp/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.amp/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.amp/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| plugins | `~/.config/amp/plugins/` | default | documented | <https://ampcode.com/docs/customize/plugins> |  |
| runtime | `~/.config/amp/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |

## amp-project

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| skills | `<project>/.agents/skills/` | default | documented | <https://ampcode.com/docs/customize/skills> |  |
| library | `<project>/.amp/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `<project>/.amp/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| plugins | `<project>/.amp/plugins/` | default | documented | <https://ampcode.com/docs/customize/plugins> |  |
| library | `<project>/.amp/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `<project>/.amp/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |

## copilot-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| hooks | `~/.copilot/hooks/` | default | documented | <https://code.visualstudio.com/docs/copilot/customization/hooks> |  |
| skills | `~/.copilot/skills/` | default | documented | <https://code.visualstudio.com/docs/copilot/customization/agent-skills> |  |
| library | `~/.github/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.github/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.github/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `~/.github/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |

## zed-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| skills | `~/.agents/skills/` | default | documented | <https://zed.dev/docs/ai/skills> |  |
| library | `~/.config/zed/.agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| context | `~/.config/zed/AGENTS.md` | default | documented | <https://zed.dev/docs/ai/instructions> |  |
| library | `~/.config/zed/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.config/zed/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.config/zed/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |

## trae-project

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| library | `<project>/.trae/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `<project>/.trae/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| hooks | `<project>/.trae/hooks.json` | default | documented | <https://docs.trae.ai/ide/hook-configuration-reference> |  |
| library | `<project>/.trae/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `<project>/.trae/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| skills | `<project>/.trae/skills/` | default | documented | <https://docs.trae.ai/ide/skills> |  |
| library | `<project>/.trae-cn/agents/` | TRAE_ENV=cn | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `<project>/.trae-cn/commands/` | TRAE_ENV=cn | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| hooks | `<project>/.trae-cn/hooks.json` | TRAE_ENV=cn | unverified | <https://docs.trae.ai/ide/hook-configuration-reference> | The CN edition keeps its files under .trae-cn; docs.trae.ai names only .trae (read on 2026-10-10). |
| library | `<project>/.trae-cn/rules/` | TRAE_ENV=cn | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `<project>/.trae-cn/scripts/` | TRAE_ENV=cn | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| skills | `<project>/.trae-cn/skills/` | TRAE_ENV=cn | unverified | <https://docs.trae.ai/ide/skills> | The CN edition keeps its files under .trae-cn; docs.trae.ai names only .trae (read on 2026-10-10). |

## junie-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| library | `~/.junie/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.junie/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| hooks | `~/.junie/config.json` | default | documented | <https://junie.jetbrains.com/docs/junie-cli-hooks.html> |  |
| library | `~/.junie/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `~/.junie/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| skills | `~/.junie/skills/` | default | documented | <https://junie.jetbrains.com/docs/agent-skills.html> |  |

## junie-project

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| library | `<project>/.junie/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `<project>/.junie/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `<project>/.junie/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| skills | `<project>/.junie/skills/` | default | documented | <https://junie.jetbrains.com/docs/agent-skills.html> |  |

## warp-project

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| rules | `<project>/.warp/rules/` | default | unverified | <https://docs.warp.dev/agent-platform/warp-agents/rules> | Warp reads AGENTS.md (and WARP.md) as rules; its docs do not name a .warp/rules directory (read on 2026-10-10). |
| skills | `<project>/.warp/skills/` | default | documented | <https://docs.warp.dev/agent-platform/warp-agents/skills> |  |
| rules | `<project>/AGENTS.md` | default | documented | <https://docs.warp.dev/agent-platform/warp-agents/rules> |  |

## kimi-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| library | `~/.kimi-code/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.kimi-code/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.kimi-code/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| skills | `~/.kimi-code/skills/` | default | documented | <https://github.com/MoonshotAI/kimi-code> |  |
| library | `$KIMI_CODE_HOME/agents/` | KIMI_CODE_HOME | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `$KIMI_CODE_HOME/commands/` | KIMI_CODE_HOME | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `$KIMI_CODE_HOME/rules/` | KIMI_CODE_HOME | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| skills | `$KIMI_CODE_HOME/skills/` | KIMI_CODE_HOME | documented | <https://github.com/MoonshotAI/kimi-code> |  |

## crush-home

| Surface | Path | Variant | Status | Source | Note |
| --- | --- | --- | --- | --- | --- |
| skills | `~/.agents/skills/` | default | documented | <https://github.com/charmbracelet/crush> |  |
| library | `~/.config/crush/agents/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `~/.config/crush/commands/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| config | `~/.config/crush/crush.json` | default | documented | <https://github.com/charmbracelet/crush> |  |
| library | `~/.config/crush/rules/` | default | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `~/.config/crush/scripts/` | default | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| library | `$XDG_CONFIG_HOME/crush/agents/` | XDG_CONFIG_HOME | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `$XDG_CONFIG_HOME/crush/commands/` | XDG_CONFIG_HOME | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| config | `$XDG_CONFIG_HOME/crush/crush.json` | XDG_CONFIG_HOME | documented | <https://github.com/charmbracelet/crush> |  |
| library | `$XDG_CONFIG_HOME/crush/rules/` | XDG_CONFIG_HOME | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `$XDG_CONFIG_HOME/crush/scripts/` | XDG_CONFIG_HOME | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
| library | `$CRUSH_GLOBAL_CONFIG/agents/` | CRUSH_GLOBAL_CONFIG | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| library | `$CRUSH_GLOBAL_CONFIG/commands/` | CRUSH_GLOBAL_CONFIG | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| config | `$CRUSH_GLOBAL_CONFIG/crush.json` | CRUSH_GLOBAL_CONFIG | documented | <https://github.com/charmbracelet/crush> |  |
| library | `$CRUSH_GLOBAL_CONFIG/rules/` | CRUSH_GLOBAL_CONFIG | egc |  | EGC library folder: a reference copy of the prompt library that the tool does not load on its own. |
| runtime | `$CRUSH_GLOBAL_CONFIG/scripts/` | CRUSH_GLOBAL_CONFIG | egc |  | EGC runtime: the scripts the tool's hook or plugin entries run. |
