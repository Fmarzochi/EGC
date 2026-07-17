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
<!-- egc:state-updated:2026-07-16T22:37:49.214Z -->
## EGC Project Memory

**Context:** EGC - projeto OSS de memoria persistente para AI coding tools. Marco: migracao completa do squad de 97 agentes do Multica pra runtimes sem custo por token (Antigravity/OpenCode), encerrando a fase de otimizacao de custo do EGC-134/144-165

**Active decisions:**
- Bug real encontrado e corrigido: 46 dos 93 agentes migrados pro Antigravity ficaram com combinacao invalida runtime=OpenCode + model=Gemini, porque um script leu snapshot desatualizado de agent_list enquanto outro script ja tinha movido esses agentes pro OpenCode nos minutos anteriores. Corrigido restaurando o modelo correto (nvidia-nim ou sambanova) baseado no log original do rebalanceamento. Confirmado 0 mismatches na frota inteira apos o fix: Explicava os erros genericos 'Unexpected server error' que pareciam ser instabilidade do Multica mas eram config quebrada minha
- SambaNova removida definitivamente do squad (provider tirado do opencode.json, 24 agentes migrados pro Antigravity/Gemini 3.5 Flash Medium): Rate limit real confirmado no log (AI_APICallError TOO MANY REQUESTS) apos o volume de testes desta sessao; Felipe ja tinha avisado que SambaNova nao e confiavel e pediu remocao assim que confirmado
- Todos os 97 agentes do workspace Multica migrados do runtime Claude pago: 93 no Antigravity (22 Gemini 3.1 Pro High, 71 Gemini 3.5 Flash Medium), 4 no OpenCode (NVIDIA Nemotron 3 Ultra, SambaNova Llama 3.3 70B). Zero agentes restantes no Claude: Felipe decidiu usar o squad em multiplos projetos de engenharia, nao so EGC; objetivo de parar de gastar o limite pago do Claude Code se cumpriu
- Dentro do Antigravity, Claude Sonnet/Opus trocado por Gemini 3.1 Pro/3.5 Flash em todos os agentes: Felipe testou empiricamente e confirmou que Claude no plano dele via Antigravity esgota token rapido demais pra terminar uma auditoria completa; Gemini no mesmo plano tem bem mais folego
- Cerebras removida definitivamente do opencode.json: Rate limit TPM reproduzido de forma consistente e persistente (ate 20min de espera sem nenhuma chamada), isolado como especifico do padrao de chamadas do opencode via curl comparativo

**Next session:**
- Estado final confirmado do squad: 71 agentes no Antigravity (Gemini 3.1 Pro High tier critico, Gemini 3.5 Flash Medium tier rotina), 26 no OpenCode (todos NVIDIA Nemotron 3 Ultra agora, SambaNova e Cerebras removidos), 0 no Claude pago, 0 mismatches de config
- Publicar a atualizacao final da nota Multica-Migracao-Squad-Sem-Custo-Token-2026-07-16.md no Obsidian quando o app abrir (MCP em timeout de novo nesta sessao) -- conteudo completo pronto em /tmp/claude-1000/-home-felipe-Projetos-EGC/788fcf04-c6d7-4f39-b913-dff7b470b074/scratchpad/Multica-OpenCode-env-vars-locais.md
- Groq nunca foi usado em massa (so testado individualmente, travou 1x) -- nao decidido se mantem ou remove tambem
- Se quiser mais resiliencia que so 2 canais (Antigravity + NVIDIA), avaliar investigar o erro de autenticacao da Cloudflare Workers AI

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
