# Token Optimization Guide

Practical settings and habits to reduce token consumption, extend session quality, and get more work done within daily limits.

> See also: `rules/common/performance.md` for model selection strategy, `skills/strategic-compact/` for automated compaction suggestions.

---

## Recommended Settings

These are recommended defaults for most users. Power users can tune values further based on their workload: for example, setting `MAX_THINKING_TOKENS` lower for simple tasks or higher for complex architectural work.

Add to your `~/.gemini/settings.json`:

```json
{
  "model": "sonnet",
  "env": {
    "MAX_THINKING_TOKENS": "10000",
    "gemini_CODE_SUBAGENT_MODEL": "haiku"
  }
}
```

### What each setting does

| Setting | Default | Recommended | Effect |
|---------|---------|-------------|--------|
| `model` | gemini-2.5-pro | **sonnet** | Sonnet handles ~80% of coding tasks well. Switch to gemini-2.5-pro with `/model gemini-2.5-pro` for complex reasoning. ~60% cost reduction. |
| `MAX_THINKING_TOKENS` | 31,999 | **10,000** | Extended thinking reserves up to 31,999 output tokens per request for internal reasoning. Reducing this cuts hidden cost by ~70%. Set to `0` to disable for trivial tasks. |
| `gemini_CODE_SUBAGENT_MODEL` | _(inherits main)_ | **haiku** | Subagents (Task tool) run on this model. Haiku is ~80% cheaper and sufficient for exploration, file reading, and test running. |

### Community note on auto-compaction overrides

Some recent Gemini Code builds have community reports that `gemini_AUTOCOMPACT_PCT_OVERRIDE` can only lower the compaction threshold, which means values below the default may compact earlier instead of later. If that happens in your setup, remove the override and rely on manual `/compact` plus egc's `strategic-compact` guidance. See [Troubleshooting](./TROUBLESHOOTING.md).

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
| **gemini-2.5-pro** | Complex architecture, multi-step reasoning, debugging subtle issues | Highest |

Switch models mid-session:

```
/model sonnet     # default for most work
/model gemini-2.5-pro       # complex reasoning
/model haiku      # quick lookups
```

---

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
- Use `/mcp` to disable Gemini Code MCP servers when you want a live runtime change. Gemini Code persists those runtime disables in `~/.gemini.json`.
- Prefer CLI tools when available (`gh` instead of GitHub MCP, `aws` instead of AWS MCP)
- Do not rely on `.gemini/settings.json` or `.gemini/settings.local.json` to disable already-loaded Gemini Code MCP servers; use `/mcp` for that.
- `EGC_DISABLED_MCPS` only affects EGC-generated MCP config output during install/sync flows, such as `install.sh`, `npx egc-install`, and Codex MCP merging. It is not a live Gemini Code toggle.
- The `memory` MCP server is configured by default but not used by any skill, agent, or hook: consider disabling it

---

## Agent Teams Cost Warning

[Agent Teams](https://code.gemini.com/docs/en/agent-teams) (experimental) spawns multiple independent context windows. Each teammate consumes tokens separately.

- Only use for tasks where parallelism adds clear value (multi-module work, parallel reviews)
- For simple sequential tasks, subagents (Task tool) are more token-efficient
- Enable with: `gemini_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings

---

## Future: configure-egc Integration

The `configure-egc` install wizard could offer to set these environment variables during setup, with explanations of the cost tradeoffs. This would help new users optimize from day one rather than discovering these settings after hitting limits.

---

## Quick Reference

```bash
# Daily workflow
/model sonnet              # Start here
/model gemini-2.5-pro                # Only for complex reasoning
/clear                     # Between unrelated tasks
/compact                   # At logical breakpoints
/cost                      # Check spending

# Environment variables (add to ~/.gemini/settings.json "env" block)
MAX_THINKING_TOKENS=10000
gemini_CODE_SUBAGENT_MODEL=haiku
gemini_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```
