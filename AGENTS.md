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

**Context:** EGC branch fix/guardian-audit-critical-security: correção completa dos 47 achados da auditoria EGC-128 (8 críticos, 10 altos, todos os médios exceto 2 refactors de manutenibilidade adiados, quase todos os baixos). 28 commits, 2825 testes JS + 114 Python verdes. Auditoria final via Antigravity (agy) em andamento antes de decidir push/PR.

**Active decisions:**
- Todos os itens baixos da auditoria resolvidos: DANGEROUS list (dd/shred/truncate), dead code render-template removido, pip-audit no CI, JA/KO/RU traducoes ja estavam corretas, resolver-bleed dedup (tag_as param em ModelResolver.model_infos), cwd threading no guardian (isProtectedPath/validateCommand agora resolvem paths relativos contra o cwd real do hook, nao process.cwd()), tags do lesson_save aceitam array alem de string (sem migracao destrutiva, 81 linhas existentes preservadas).
- 2 refactors medios (funcao de 166 linhas em install-manifests.js resolveInstallPlan, funcao grande em install-lifecycle.js) deliberadamente NAO feitos nesta sessao.

**Next session:**
- Aguardar resultado da auditoria final via agy --print (rodando em background) sobre o diff completo main...fix/guardian-audit-critical-security.
- Decidir com Felipe: push + PR da branch fix/guardian-audit-critical-security.
- Se Felipe autorizar, fazer os 2 refactors medios pendentes em sessao dedicada.
<!-- egc:end -->
