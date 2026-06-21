# EGC: Agent Catalog

Extended Global Context (EGC) is a production-grade, multi-agent system providing 63 specialized agents, 229+ skills, 76 commands to any compatible AI coding environment.

## Quick Start

Install once and get access to the full catalog:

```bash
node scripts/install-apply.js --target egc
```

## Project Structure

```
agents/    : 63 specialized subagents
skills/    : 229+ workflow skills and domain knowledge
commands/  : 76 slash commands
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

