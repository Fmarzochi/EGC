# The Shorthand Guide to Everything Claude Code

> A complete setup guide after 10 months of daily use: skills, hooks, subagents, MCPs, plugins, and what actually works.

## Overview

I've been an avid Claude Code user since the experimental rollout in February 2025, and won the Anthropic x Forum Ventures hackathon with [Zenith](https://zenith.chat/) alongside [@DRodriguezFX](https://x.com/DRodriguezFX) completely using Claude Code.

This guide covers the foundational setup: skills and commands, hooks, subagents, MCPs, plugins, and the configuration patterns that form the backbone of an effective Claude Code workflow.

## Skills and Commands

Skills operate like rules, constrained to certain scopes and workflows. They're shorthand to prompts when you need to execute a particular workflow.

After a long session of coding with Opus 4.5, you want to clean out dead code and loose .md files?
Run `/refactor-clean`. Need testing? `/tdd`, `/e2e`, `/test-coverage`. Skills and commands can be chained together in a single prompt.

You can make a skill that updates codemaps at checkpoints - a way for Claude to quickly navigate your codebase without burning context on exploration.

### Structure

**Skills:**
- Location: `~/.claude/skills`
- Purpose: Broader workflow definitions
- Usage: Referenced via `/` commands or skill names

**Commands:**
- Location: `~/.claude/commands`
- Purpose: Quick executable prompts
- Usage: Quick executable prompts via slash commands

```bash
# Example skill structure
~/.claude/skills/
  pmx-guidelines.md          # Project-specific patterns
  coding-standards.md        # Language best practices
  tdd-workflow/              # Multi-file skill with README.md
  security-review/           # Checklist-based skill
```

## Hooks

Hooks are trigger-based automations that fire on specific events. Unlike skills, they're constrained to tool calls and lifecycle events.

### Hook Types

1. **PreToolUse** - Before a tool executes (validation, reminders)
2. **PostToolUse** - After a tool finishes (formatting, feedback loops)
3. **UserPromptSubmit** - When you send a message
4. **Stop** - When Claude finishes responding
5. **PreCompact** - Before context compaction
6. **Notification** - Permission requests

### Example: tmux reminder before long-running commands

```json
{
  "PreToolUse": [
    {
      "matcher": "tool == \"Bash\" && tool_input.command matches \"(npm|pnpm|yarn|cargo|pytest)\"",
      "hooks": [
        {
          "type": "command",
          "command": "if [ -z \"$TMUX\" ]; then echo '[Hook] Consider tmux for session persistence' >&2; fi"
        }
      ]
    }
  ]
}
```

**Pro tip:** Use the `hookify` plugin to create hooks conversationally instead of writing JSON manually. Run `/hookify` and describe what you want.

## Subagents

Subagents are processes your orchestrator (main Claude) can delegate tasks to with limited scopes. They can run in background or foreground, freeing up context for the main agent.

Subagents work nicely with skills - a subagent capable of executing a subset of your skills can be delegated tasks and use those skills autonomously. They can also be sandboxed with specific tool permissions.

```bash
# Example subagent structure
~/.claude/agents/
  planner.md                 # Feature implementation planning
  architect.md               # System design decisions
  tdd-guide.md              # Test-driven development
  code-reviewer.md          # Quality/security review
  security-reviewer.md      # Vulnerability analysis
  build-error-resolver.md
  e2e-runner.md
  refactor-cleaner.md
```

Configure allowed tools, MCPs, and permissions per subagent for proper scoping.

## Rules and Memory

Your `.rules` folder holds `.md` files with best practices Claude should ALWAYS follow. Two approaches:

1. **Single CLAUDE.md** - Everything in one file (user or project level)
2. **Rules folder** - Modular `.md` files grouped by concern

```bash
~/.claude/rules/
  security.md               # No hardcoded secrets, validate inputs
  coding-style.md           # Immutability, file organization
  testing.md                # TDD workflow, 80% coverage
  git-workflow.md           # Commit format, PR process
  agents.md                 # When to delegate to subagents
  performance.md            # Model selection, context management
```

### Example rules

- No emojis in codebase
- Refrain from purple hues in frontend
- Always test code before deployment
- Prioritize modular code over mega-files
- Never commit console.logs

## MCPs (Model Context Protocol)

MCPs connect Claude to external services directly. Not a replacement for APIs - it's a prompt-driven wrapper around them, allowing more flexibility in navigating information.

**Example:** Supabase MCP lets Claude pull specific data, run SQL directly upstream without copy-paste. Same for databases, deployment platforms, etc.

### Chrome in Claude

A built-in plugin MCP that lets Claude autonomously control your browser - clicking around to see how things work.

### Context Window Management (CRITICAL)

Be picky with MCPs. Keep all MCPs in user config but disable everything unused. Navigate to `/plugins` and scroll down or run `/mcp`.

Your 200k context window before compacting might only be 70k with too many tools enabled. Performance degrades significantly.

**Rule of thumb:**
- Have 20-30 MCPs in config
- Keep under 10 enabled / under 80 tools active

## Plugins

Plugins package tools for easy installation instead of tedious manual setup. A plugin can be a skill + MCP combined, or hooks/tools bundled together.

### Installing plugins

```bash
# Add a marketplace
claude plugin marketplace add https://github.com/mixedbread-ai/mgrep

# Open Claude, run /plugins, find new marketplace, install from there
```

### LSP Plugins

Language Server Protocol gives Claude real-time type checking, go-to-definition, and intelligent completions without needing an IDE open.

```bash
# Enabled plugins example
typescript-lsp@claude-plugins-official      # TypeScript intelligence
pyright-lsp@claude-plugins-official         # Python type checking
hookify@claude-plugins-official             # Create hooks conversationally
mgrep@Mixedbread-Grep                       # Better search than ripgrep
```

**Warning:** Watch your context window.

## Tips and Tricks

### Keyboard Shortcuts

- `Ctrl+U` - Delete entire line (faster than backspace spam)
- `!` - Quick bash command prefix
- `@` - Search for files
- `/` - Initiate slash commands
- `Shift+Enter` - Multi-line input
- `Tab` - Toggle thinking display
- `Esc Esc` - Interrupt Claude / restore code

### Parallel Workflows

`/fork` - Fork conversations to do non-overlapping tasks in parallel instead of spamming queued messages

### Git Worktrees

For overlapping parallel Claudes without conflicts. Each worktree is an independent checkout.

```bash
git worktree add ../feature-branch feature-branch
# Now run separate Claude instances in each worktree
```

### tmux for Long-Running Commands

Stream and watch logs/bash processes Claude runs.

```bash
tmux new -s dev                   # Claude runs commands here
tmux attach -t dev               # You can detach and reattach
```

### mgrep > grep

`mgrep` is a significant improvement from ripgrep/grep. Install via plugin marketplace, then use the `/mgrep` skill. Works with both local search and web search.

```bash
mgrep "function handleSubmit"                # Local search
mgrep --web "Next.js 15 app router changes" # Web search
```

### Other Useful Commands

- `/rewind` - Go back to a previous state
- `/statusline` - Customize with branch, context %, todos
- `/checkpoints` - File-level undo points
- `/compact` - Manually trigger context compaction

### GitHub Actions CI/CD

Set up code review on your PRs with GitHub Actions. Claude can review PRs automatically when configured.

### Sandboxing

Use sandbox mode for risky operations - Claude runs in restricted environment without affecting your actual system. (Use `--dangerously-skip-permissions` to do the opposite and let claude roam free, this can be destructive if not careful.)

## On Editors

While an editor isn't needed it can positively or negatively impact your Claude Code workflow. While Claude Code works from any terminal, pairing it with a capable editor unlocks real-time file tracking, quick navigation, and integrated command execution.

### Zed (My Preference)

I use [Zed](https://zed.dev/) - a Rust-based editor that's lightweight, fast, and highly customizable.

**Why Zed works well with Claude Code:**

- **Agent Panel Integration** - Zed's Claude integration lets you track file changes in real-time as Claude edits. Jump between files Claude references without leaving the editor
- **Performance** - Written in Rust, opens instantly and handles large codebases without lag
- **CMD+Shift+R Command Palette** - Quick access to all your custom slash commands, debuggers, and tools in a searchable UI
- **Minimal Resource Usage** - Won't compete with Claude for system resources during heavy operations
- **Vim Mode** - Full vim keybindings if that's your thing

**Setup:**

1. Split your screen - Terminal with Claude Code on one side, editor on the other
2. `Ctrl + G` - Quickly open the file Claude is currently working on in Zed
3. Enable autosave so Claude's file reads are always current
4. Use editor's git features to review Claude's changes before committing
5. Enable file watchers - Most editors auto-reload changed files

### VSCode / Cursor

Also viable. Works well with Claude Code. Use in either terminal format with automatic sync using `\ide` enabling LSP functionality, or use the extension which is more integrated.

## Key Takeaways

1. Don't overcomplicate - treat configuration like fine-tuning, not architecture
2. Context window is precious - disable unused MCPs and plugins
3. Parallel execution - fork conversations, use git worktrees
4. Automate the repetitive - hooks for formatting, linting, reminders
5. Scope your subagents - limited tools = focused execution

## References

- [Plugins Reference](https://code.claude.com/docs/en/plugins-reference)
- [Hooks Documentation](https://code.claude.com/docs/en/hooks)
- [Checkpointing](https://code.claude.com/docs/en/checkpointing)
- [Interactive Mode](https://code.claude.com/docs/en/interactive-mode)
- [Memory System](https://code.claude.com/docs/en/memory)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [MCP Overview](https://code.claude.com/docs/en/mcp-overview)

---

*Note: This is a subset of detail. More posts on specifics may follow if there's interest.*
