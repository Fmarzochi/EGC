# EGC: Agent Catalog

Extended Global Context (EGC) is a production-grade, multi-agent system providing 63 specialized agents, 230+ skills, 77 commands to any compatible AI coding environment.

## Quick Start

Install once and get access to the full catalog:

```bash
node scripts/install-apply.js --target egc
```

## Project Structure

```
agents/    : 63 specialized subagents
skills/    : 230+ workflow skills and domain knowledge
commands/  : 77 slash commands
```

## Agents

Each agent in `agents/` is a Markdown file with YAML frontmatter declaring its name, description, model, and tools. Agents are loaded automatically by the EGC runtime and made available to the orchestrator.

### Available Agents

| Agent | Description |
|-------|-------------|
| a11y-architect | Accessibility Architect specializing in WCAG 2.2 compliance |
| architect | System design and architecture guidance |
| build-error-resolver | Diagnoses and resolves build and compilation errors |
| chief-of-staff | High-level project coordination and planning |
| code-architect | Code structure and design patterns |
| code-explorer | Codebase navigation and understanding |
| code-reviewer | Comprehensive code review and feedback |
| code-simplifier | Refactoring and simplification guidance |
| comment-analyzer | Code comment quality and documentation analysis |

And many more: see `agents/*.md` for the full list.

## Runtime

The EGC runtime routes tasks to the appropriate agent using the execution orchestrator, session manager, and tracer. Agents communicate via the LLM dispatcher, which supports Gemini, Claude, OpenAI, OpenRouter, and Ollama providers.

## MCP Servers

- `egc-guardian`: `validate_command`, `validate_write`, `reduce_context`, `orchestrate_task`
- `egc-memory`: `get_state`, `update_state`, `store_decision`, `query_history`, `search_history`

Run `sh install.sh` to build the servers. Run `egc doctor` to verify they are registered and running.

## EGC Guardian Protocol — MANDATORY

These calls are automatic and non-negotiable. Never wait for the user to ask.

**Start of every task (non-trivial):** call `orchestrate_task({ prompt: "<task>" })`
**Before every shell/Bash command:** call `validate_command({ command: "<cmd>" })`
**Before every new file Write or Edit on a file not yet read:** call `validate_write({ filepath: "<path>" })`

Skipping any of these breaks the EGC contract. There are no exceptions for "simple" tasks.

<!-- egc:start -->
## EGC Project Memory

## EGC Natural Language Interface

Detect user intent in any language and call the matching EGC tool — no keywords required:

**Session**
- User resumes work (any language) → `get_state`
- User ends session (any language) → `update_state`

**Diagnosis — when AI seems confused or hallucinating**
- User questions whether things are working → `get_project_state`
- User asks what mistakes keep repeating → `detect_patterns`
- User asks what was learned in past sessions → `lesson_recall`

**Memory — user forces a save**
- User asks to record a decision → `store_decision`
- User asks AI not to repeat a mistake → `lesson_save`
- User confirms a past lesson happened again → `lesson_reinforce`
- User wants to store something temporarily → `working_memory_set`
- User asks what is in temporary memory → `working_memory_get` / `working_memory_list`

**Search — when AI forgot something**
- User asks about past decisions on a topic → `search_history`
- User asks for recent decisions chronologically → `query_history`

**Context — when heavy**
- User says context is full or heavy → `reduce_context`
- User asks to compress session observations → `compress_observations`

**Safety — when user is suspicious**
- User asks if a shell command is safe → `validate_command`
- User asks if a file path is safe to write → `validate_write`
- User asks to organize a complex task → `orchestrate_task`
- User asks AI to learn from session errors → `auto_learn`
<!-- egc:end -->
