# Token Optimization Guide

Practical settings and habits to reduce token consumption, extend session quality, and get more work done within daily limits.

> See also: `rules/common/performance.md` for model selection strategy, `skills/strategic-compact/` for automated compaction suggestions.

---

## Recommended Settings

These are recommended defaults for most users. Power users can tune values further based on their workload: for example, setting `MAX_THINKING_TOKENS` lower for simple tasks or higher for complex architectural work.

Add to your `~/.claude/settings.json`:

```json
{
  "model": "sonnet",
  "env": {
    "MAX_THINKING_TOKENS": "10000",
    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku"
  }
}
```

### What each setting does

| Setting | Default | Recommended | Effect |
|---------|---------|-------------|--------|
| `model` | opus | **sonnet** | Sonnet handles ~80% of coding tasks well. Switch to opus with `/model opus` for complex reasoning. ~60% cost reduction. |
| `MAX_THINKING_TOKENS` | 31,999 | **10,000** | Extended thinking reserves up to 31,999 output tokens per request for internal reasoning. Reducing this cuts hidden cost by ~70%. Set to `0` to disable for trivial tasks. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | _(inherits main)_ | **haiku** | Subagents (Task tool) run on this model. Haiku is ~80% cheaper and sufficient for exploration, file reading, and test running. |

### Community note on auto-compaction overrides

Some recent Claude Code builds have community reports that `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can only lower the compaction threshold, which means values below the default may compact earlier instead of later. If that happens in your setup, remove the override and rely on manual `/compact` plus egc's `strategic-compact` guidance. See [Troubleshooting](./TROUBLESHOOTING.md).

### Toggling extended thinking

- **Alt+T** (Windows/Linux) or **Option+T** (macOS): toggle on/off
- **Ctrl+O**: see thinking output (verbose mode)

---

## Model Selection

Use the right model for the task:

| Model | Best for | Cost |
|-------|----------|------|
| **Haiku** | Subagent exploration, file reading, simple lookups | Lowest |
| **Sonnet** | Day-to-day coding, reviews, test writing, implementation | Medium |
| **opus** | Complex architecture, multi-step reasoning, debugging subtle issues | Highest |

Switch models mid-session:

```
/model sonnet     # default for most work
/model opus       # complex reasoning
/model haiku      # quick lookups
```

---

## Token Crusher (built into EGC)

Since v1.1.12 the biggest lever ships with the package: the Token Crusher compresses noisy shell output before it reaches the model. Long `git log`/`git diff`, test-runner noise, package-manager installs and large `gh --json` payloads shrink by up to 90%, with errors, warnings and failures always preserved.

| Command | What it does |
|---------|--------------|
| `egc run <cmd>` | Runs the command and crushes the output before the model reads it |
| `egc run --raw <cmd>` | Escape hatch: full output when you need every line |
| `egc saved` | Accumulated savings report, computed locally at zero token cost |

On hook-capable harnesses eligible simple commands are routed through `egc run` automatically by the bash dispatcher; opt out with `EGC_DISABLED_HOOKS=pre:bash:crusher-rewrite`.

## Context Management

### Commands

| Command | When to use |
|---------|-------------|
| `/clear` | Between unrelated tasks. Stale context wastes tokens on every subsequent message. |
| `/compact` | At logical task breakpoints (after planning, after debugging, before switching focus). |
| `/cost` | Check token spending for the current session. |

### Strategic compaction

The `strategic-compact` skill (in `skills/strategic-compact/`) suggests `/compact` at logical intervals rather than relying on auto-compaction, which can trigger mid-task. See the skill's README for hook setup instructions.

**When to compact:**
- After exploration, before implementation
- After completing a milestone
- After debugging, before continuing with new work
- Before a major context shift

**When NOT to compact:**
- Mid-implementation of related changes
- While debugging an active issue
- During multi-file refactoring

### Subagents protect your context

Use subagents (Task tool) for exploration instead of reading many files in your main session. The subagent reads 20 files but only returns a summary: your main context stays clean.

---

## Compressing Observations

EGC records raw hook events (tool calls, file edits, errors) in the state-store database. Over time these accumulate. The `compress_observations` MCP tool processes them into typed summaries:

```
compress_observations({ limit: 50 })
```

This replaces verbose raw records with compact entries like `tool_failure`, `tool_success`, and `file_edit`, drastically reducing the token cost of injecting history into a new session. Run it at logical session breakpoints or when the observation count grows large.

---

## MCP Server Management

Each enabled MCP server adds tool definitions to your context window. The README warns: **keep under 10 enabled per project**.

Tips:
- Run `/mcp` to see active servers and their context cost
- Use `/mcp` to disable Claude Code MCP servers when you want a live runtime change. Claude Code persists those runtime disables in `~/.claude.json`.
- Prefer CLI tools when available (`gh` instead of GitHub MCP, `aws` instead of AWS MCP)
- Do not rely on `.claude/settings.json` or `.claude/settings.local.json` to disable already-loaded Claude Code MCP servers; use `/mcp` for that.
- `EGC_DISABLED_MCPS` only affects EGC-generated MCP config output during install/sync flows, such as `install.sh`, `npx egc-install`, and Codex MCP merging. It is not a live Claude Code toggle.
- The `memory` MCP server is configured by default but not used by any skill, agent, or hook: consider disabling it

---

## Agent Teams Cost Warning

[Agent Teams](https://code.claude.com/docs/en/agent-teams) (experimental) spawns multiple independent context windows. Each teammate consumes tokens separately.

- Only use for tasks where parallelism adds clear value (multi-module work, parallel reviews)
- For simple sequential tasks, subagents (Task tool) are more token-efficient
- Enable with: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings

---

## Future: configure-egc Integration

The `configure-egc` install wizard could offer to set these environment variables during setup, with explanations of the cost tradeoffs. This would help new users optimize from day one rather than discovering these settings after hitting limits.

---

## Quick Reference

```bash
# Daily workflow
/model sonnet              # Start here
/model opus                # Only for complex reasoning
/clear                     # Between unrelated tasks
/compact                   # At logical breakpoints
/cost                      # Check spending

# Environment variables (add to ~/.claude/settings.json "env" block)
MAX_THINKING_TOKENS=10000
CLAUDE_CODE_SUBAGENT_MODEL=haiku
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```
