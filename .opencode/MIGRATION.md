# Migration Guide: Claude Code to OpenCode

This guide helps you migrate from Claude Code to OpenCode while using the Extended Global Context (EGC) configuration.

## Overview

OpenCode is an alternative CLI for AI-assisted development that supports **all** the same features as Claude Code, with some differences in configuration format.

## Key Differences

| Feature | Claude Code | OpenCode | Notes |
|---------|-------------|----------|-------|
| Configuration | `GEMINI.md`, `plugin.json` | `opencode.json` | Different file formats |
| Agents | Markdown frontmatter | JSON object | Full parity |
| Commands | `commands/*.md` | `command` object or `.md` files | Full parity |
| Skills | `skills/*/SKILL.md` | `instructions` array | Loaded as context |
| **Hooks** | `hooks.json` (3 phases) | **Plugin system (20+ events)** | **Full parity + more!** |
| Rules | `rules/*.md` | `instructions` array | Consolidated or separate |
| MCP | Full support | Full support | Full parity |

## Hook Migration

**OpenCode fully supports hooks** via its plugin system, which is actually MORE sophisticated than Claude Code with 20+ event types.

### Hook Event Mapping

| Claude Code Hook | OpenCode Plugin Event | Notes |
|-----------------|----------------------|-------|
| `PreToolUse` | `tool.execute.before` | Can modify tool input |
| `PostToolUse` | `tool.execute.after` | Can modify tool output |
| `Stop` | `session.idle` or `session.status` | Session lifecycle |
| `SessionStart` | `session.created` | Session begins |
| `SessionEnd` | `session.deleted` | Session ends |
| N/A | `file.edited` | OpenCode-only: file changes |
| N/A | `file.watcher.updated` | OpenCode-only: file system watch |
| N/A | `message.updated` | OpenCode-only: message changes |
| N/A | `lsp.client.diagnostics` | OpenCode-only: LSP integration |
| N/A | `tui.toast.show` | OpenCode-only: notifications |

### Converting Hooks to Plugins

**Claude Code hook (hooks.json):**
```json
{
  "PostToolUse": [{
    "matcher": "tool == \"Edit\" && tool_input.file_path matches \"\\\\.(ts|tsx|js|jsx)$\"",
    "hooks": [{
      "type": "command",
      "command": "prettier --write \"$file_path\""
    }]
  }]
}
```

**OpenCode plugin (.opencode/plugins/prettier-hook.ts):**
```typescript
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

// One default export, read by both loaders: OpenCode 2 takes `id` and
// `setup`, OpenCode 1 (1.18.29 and newer) takes `server`. Nothing else is
// exported, since OpenCode 1 calls every export as a plugin of its own.
export default {
  id: "prettier-hook",
  // OpenCode 2 registers hooks on the context it hands over; no shell comes
  // with it, so the formatter runs through child_process and is awaited, as
  // the V1 branch awaits the shell.
  async setup(ctx) {
    await ctx.tool.hook("execute.after", async (event) => {
      const file = event.input?.filePath
      if (event.tool === "edit" && /\.(ts|tsx|js|jsx)$/.test(file)) await run("prettier", ["--write", file])
    })
  },
  // OpenCode 1 reads the hooks object and hands over Bun's shell.
  async server({ $ }) {
    return {
      "tool.execute.after": async (input) => {
        const file = input.args?.filePath
        if (input.tool === "edit" && /\.(ts|tsx|js|jsx)$/.test(file)) await $`prettier --write ${file}`
      },
    }
  },
}
```

### EGC Plugin Hooks Included

The EGC OpenCode configuration includes translated hooks:

| Hook | OpenCode 1 event | OpenCode 2 hook | Purpose |
|------|------|------|---------|
| Guardian and Fact-Forcing Gate | `tool.execute.before` | `tool.hook("execute.before")` | Refuse denied commands and protected writes, ask for the facts before the first edit |
| Dashboard and changed files | `tool.execute.before`, `tool.execute.after` | `tool.hook("execute.before")`, `tool.hook("execute.after")` | Telemetry and change tracking |
| Session lifecycle and file edits | `event` | `event.subscribe` | console.log audit, cleanup, edit tracking |
| Shell environment | `shell.env` | `shell.hook("create.before")` | Project variables for every command |
| Compaction | `experimental.session.compacting` | `session.hook("compaction")` | EGC block kept across a compaction |
| Permissions | `permission.ask` | `permission.hook("evaluate")` | Read-only tools, formatters and test runners allowed |

## Migration Steps

### 1. Install OpenCode

```bash
# Install OpenCode CLI
npm install -g opencode
# or
curl -fsSL https://opencode.ai/install | bash
```

### 2. Use the EGC OpenCode Configuration

The `.opencode/` directory in this repository contains the translated configuration:

```
.opencode/
├── opencode.json              # Main configuration
├── plugins/                   # Hook plugins (translated from hooks.json)
│   ├── egc-hooks.ts           # All EGC hooks as plugins
│   └── index.ts               # Plugin exports
├── tools/                     # Custom tools
│   ├── run-tests.ts           # Run test suite
│   ├── check-coverage.ts      # Check coverage
│   └── security-audit.ts      # npm audit wrapper
├── commands/                  # All 23 commands (markdown)
│   ├── plan.md
│   ├── tdd.md
│   └── ... (21 more)
├── prompts/
│   └── agents/                # Agent prompt files (12)
├── instructions/
│   └── INSTRUCTIONS.md        # Consolidated rules
├── package.json               # For npm distribution
├── tsconfig.json              # TypeScript config
└── MIGRATION.md               # This file
```

### 3. Run OpenCode

```bash
# In the repository root
opencode

# The configuration is automatically detected from .opencode/opencode.json
```

## Concept Mapping

### Agents

**Claude Code:**
```markdown
---
name: planner
description: Expert planning specialist...
tools: ["Read", "Grep", "Glob"]
model: gemini-2.5-pro
---

You are an expert planning specialist...
```

**OpenCode:**
```json
{
  "agent": {
    "planner": {
      "description": "Expert planning specialist...",
      "mode": "subagent",
      "model": "pro",
      "prompt": "{file:prompts/agents/planner.txt}",
      "tools": { "read": true, "bash": true }
    }
  }
}
```

### Commands

**Claude Code:**
```markdown
---
name: plan
description: Create implementation plan
---

Create a detailed implementation plan for: {input}
```

**OpenCode (JSON):**
```json
{
  "command": {
    "plan": {
      "description": "Create implementation plan",
      "template": "Create a detailed implementation plan for: $ARGUMENTS",
      "agent": "planner"
    }
  }
}
```

**OpenCode (Markdown - .opencode/commands/plan.md):**
```markdown
---
description: Create implementation plan
agent: egc:planner
---

Create a detailed implementation plan for: $ARGUMENTS
```

### Skills

**Claude Code:** Skills are loaded from `skills/*/SKILL.md` files.

**OpenCode:** Skills are added to the `instructions` array:
```json
{
  "instructions": [
    "skills/tdd-workflow/SKILL.md",
    "skills/security-review/SKILL.md",
    "skills/coding-standards/SKILL.md"
  ]
}
```

### Rules

**Claude Code:** Rules are in separate `rules/*.md` files.

**OpenCode:** Rules can be consolidated into `instructions` or kept separate:
```json
{
  "instructions": [
    "instructions/INSTRUCTIONS.md",
    "rules/common/security.md",
    "rules/common/coding-style.md"
  ]
}
```

## Model Mapping

| Claude Code | OpenCode |
|-------------|----------|
| `opus` | `anthropic/claude-opus-4-5` |
| `sonnet` | `anthropic/claude-sonnet-4-5` |
| `haiku` | `anthropic/claude-haiku-4-5` |

## Available Commands

After migration, ALL 23 commands are available:

| Command | Description |
|---------|-------------|
| `/plan` | Create implementation plan |
| `/tdd` | Enforce TDD workflow |
| `/code-review` | Review code changes |
| `/security` | Run security review |
| `/build-fix` | Fix build errors |
| `/e2e` | Generate E2E tests |
| `/refactor-clean` | Remove dead code |
| `/orchestrate` | Multi-agent workflow |
| `/learn` | Extract patterns mid-session |
| `/checkpoint` | Save verification state |
| `/verify` | Run verification loop |
| `/eval` | Run evaluation |
| `/update-docs` | Update documentation |
| `/update-codemaps` | Update codemaps |
| `/test-coverage` | Check test coverage |
| `/setup-pm` | Configure package manager |
| `/go-review` | Go code review |
| `/go-test` | Go TDD workflow |
| `/go-build` | Fix Go build errors |
| `/skill-create` | Generate skills from git history |
| `/instinct-status` | View learned instincts |
| `/instinct-import` | Import instincts |
| `/instinct-export` | Export instincts |
| `/evolve` | Cluster instincts into skills |
| `/promote` | Promote project instincts to global scope |
| `/projects` | List known projects and instinct stats |

## Available Agents

| Agent | Description |
|-------|-------------|
| `planner` | Implementation planning |
| `architect` | System design |
| `code-reviewer` | Code review |
| `security-reviewer` | Security analysis |
| `tdd-guide` | Test-driven development |
| `build-error-resolver` | Fix build errors |
| `e2e-runner` | E2E testing |
| `doc-updater` | Documentation |
| `refactor-cleaner` | Dead code cleanup |
| `go-reviewer` | Go code review |
| `go-build-resolver` | Go build errors |
| `database-reviewer` | Database optimization |

## Plugin Installation

### Option 1: Use EGC Configuration Directly

The `.opencode/` directory contains everything pre-configured.

### Option 2: Install as npm Package

```bash
npm install egc-universal
```

Then in your `opencode.json`:
```json
{
  "plugin": ["egc-universal"]
}
```

This only loads the published EGC OpenCode plugin module (hooks/events and exported plugin tools).
It does **not** automatically inject EGC's full `agent`, `command`, or `instructions` config into your project.

If you want the full EGC OpenCode workflow surface, use the repository's bundled `.opencode/opencode.json` as your base config or copy these pieces into your project:
- `.opencode/commands/`
- `.opencode/prompts/`
- `.opencode/instructions/INSTRUCTIONS.md`
- the `agent` and `command` sections from `.opencode/opencode.json`

## Troubleshooting

### Configuration Not Loading

1. Verify `.opencode/opencode.json` exists in the repository root
2. Check JSON syntax is valid: `cat .opencode/opencode.json | jq .`
3. Ensure all referenced prompt files exist

### Plugin Not Loading

1. Verify plugin file exists in `.opencode/plugins/`
2. Check TypeScript syntax is valid
3. Ensure `plugin` array in `opencode.json` includes the path
4. On OpenCode 2, the module must have a default export with an `id` and a `setup` function; a module that exports a function by name is refused with `Plugin must export a default definition with an id and an effect or setup function`. OpenCode 1 calls every export as a plugin, so keep that definition as the only export, with the V1 hooks object under its `server` entry

### Agent Not Found

1. Check the agent is defined in `opencode.json` under the `agent` object
2. Verify the prompt file path is correct
3. Ensure the prompt file exists at the specified path

### Command Not Working

1. Verify the command is defined in `opencode.json` or as `.md` file in `.opencode/commands/`
2. Check the referenced agent exists
3. Ensure the template uses `$ARGUMENTS` for user input
4. If you installed only `plugin: ["egc-universal"]`, note that npm plugin install does not auto-add EGC commands or agents to your project config

## Best Practices

1. **Start Fresh**: Don't try to run both Claude Code and OpenCode simultaneously
2. **Check Configuration**: Verify `opencode.json` loads without errors
3. **Test Commands**: Run each command once to verify it works
4. **Use Plugins**: Leverage the plugin hooks for automation
5. **Use Agents**: Leverage the specialized agents for their intended purposes

## Reverting to Claude Code

If you need to switch back:

1. Simply run `claude` instead of `opencode`
2. Claude Code will use its own configuration (`CLAUDE.md`, `plugin.json`, etc.)
3. The `.opencode/` directory won't interfere with Claude Code

## Feature Parity Summary

| Feature | Claude Code | OpenCode | Status |
|---------|-------------|----------|--------|
| Agents | PASS: 12 agents | PASS: 12 agents | **Full parity** |
| Commands | PASS: 23 commands | PASS: 23 commands | **Full parity** |
| Skills | PASS: 16 skills | PASS: 16 skills | **Full parity** |
| Hooks | PASS: 3 phases | PASS: 20+ events | **OpenCode has MORE** |
| Rules | PASS: 8 rules | PASS: 8 rules | **Full parity** |
| MCP Servers | PASS: Full | PASS: Full | **Full parity** |
| Custom Tools | PASS: Via hooks | PASS: Native support | **OpenCode is better** |

## Feedback

For issues specific to:
- **OpenCode CLI**: Report to OpenCode's issue tracker
- **EGC Configuration**: Report to [github.com/Fmarzochi/EGC](https://github.com/Fmarzochi/EGC)
