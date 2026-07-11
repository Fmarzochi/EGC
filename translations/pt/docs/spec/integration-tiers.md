# Niveis de Integracao do EGC

> O mapa honesto de como cada ferramenta de IA suportada se integra com o EGC.

O EGC suporta 14 ferramentas de IA por meio de 3 mecanismos de integracao distintos. Este documento e a fonte de verdade sobre o que esta e nao esta integrado, e em qual profundidade.

## Definicoes de Nivel

| Nivel | Nome | O que e publicado | Pipeline de instalacao |
|-------|------|-------------------|------------------------|
| **1** | Unificado completo | Skills, agentes, regras, hooks, MCP, manifesto de instalacao | `scripts/install-apply.js` via `SUPPORTED_INSTALL_TARGETS` |
| **2** | Script customizado | Ativos especificos da ferramenta via instalador dedicado | `.{ferramenta}/install.sh` chamado por `install.sh` |
| **3** | Somente protocolo | Registro do servidor MCP + injecao de protocolo de memoria | `scripts/bootstrap-cognitive.js` + registro MCP em `install.sh` |

## Os 14 Harnesses

| # | Ferramenta | Nivel | Target id | Caminho de instalacao | Notas |
|---|------------|-------|-----------|----------------------|-------|
| 1 | **Claude Code** | 1 | `claude` | `~/.claude/skills/<nome>/SKILL.md` | Skills instaladas de forma plana; MCP + bootstrap cognitivo via `~/.claude/CLAUDE.md` |
| 2 | **Antigravity (AGY)** | 1 | `antigravity` | `~/.gemini/` (compartilhado com Gemini CLI) | Reutiliza GEMINI.md do Gemini CLI |
| 3 | **Gemini CLI** | 1 | `gemini` | `~/.gemini/` | Bootstrap cognitivo em `GEMINI.md` |
| 4 | **Cursor** | 1 | `cursor` | `~/.cursor/` | Regras injetadas no cursor.rules global |
| 5 | **Codex CLI** | 1 | `codex` | `~/.agents/skills/<nome>/SKILL.md` | Skills instaladas de forma plana; `persistent_instructions` adicionado |
| 6 | **OpenCode** | 1 | `opencode` | `~/.config/opencode/skills/<nome>/SKILL.md` | Eventos de plugin nativos para hooks |
| 7 | **CodeBuddy** | 1 | `codebuddy` | `.codebuddy/skills/<nome>/SKILL.md` | Injecao de contexto |
| 8 | **Windsurf** | 1 | `windsurf` | `~/.codeium/windsurf/skills/<nome>/SKILL.md` | Skills instaladas de forma plana |
| 9 | **Amp** | 1 | `amp` | `~/.amp/skills/<nome>/SKILL.md` | Skills instaladas de forma plana |
| 10 | **VS Code Copilot** | 1 | `copilot` | `~/.github/skills/<nome>/SKILL.md` | Skills instaladas de forma plana |
| 11 | **Zed** | 1 | `zed` | `~/.config/zed/skills/<nome>/` | Skills instaladas de forma plana (categoria removida); MCP via `context_servers` em `settings.json`; bootstrap cognitivo em `~/.config/zed/AGENTS.md` |
| 12 | **Continue.dev** | 1 | `continue` | `~/.continue/skills/<nome>/SKILL.md` | Skills instaladas de forma plana; MCP via arquivos de bloco YAML em `~/.continue/mcpServers/`; prompt do protocolo de memoria em `~/.continue/prompts/`; regras descobertas nativamente em `.continue/rules/` do workspace |
| 13 | **Kiro** | 2 | (nenhum) | `~/.kiro/` via `.kiro/install.sh` | Hooks de sessao instalados em `~/.kiro/hooks/` |
| 14 | **Trae** | 2 | (nenhum) | `~/.trae/` (ou `~/.trae-cn/` com `TRAE_ENV=cn`) via `.trae/install.sh` | Protocolo de memoria gravado em `~/.trae/MEMORY.md` |

## Por que tres niveis (historia, nao aspiracao)

O Nivel 1 (unificado) e o pipeline canonico. E o resultado de `install-plan.js` resolvendo manifestos de instalacao contra `SUPPORTED_INSTALL_TARGETS`, depois `install-apply.js` materializando arquivos. O pipeline emite procedencia, suporta dry-run e e coberto por 200+ testes em `tests/`.

O Nivel 2 (script customizado) existe porque Kiro e Trae chegaram ao EGC antes de o pipeline unificado estar estavel. Seus instaladores fazem aproximadamente o mesmo trabalho que o pipeline unificado, mas a forma dos ativos que publicam difere o suficiente para que a retrocompatibilizacao seja nao trivial. Sao de primeira classe, mas tecnicamente isolados.

O Nivel 3 (somente protocolo) e o ponto de entrada para qualquer ferramenta que suporte MCP. O Claude Code era anteriormente Nivel 3, mas agora suporta `~/.claude/skills/<nome>/SKILL.md` como caminho de descoberta de skills, portanto foi promovido ao Nivel 1 com target id `claude`. Windsurf, Amp e VS Code Copilot foram adicionados como targets Nivel 1 na v1.0.2 seguindo o mesmo padrao de descoberta de skills. O Continue.dev seguiu o mesmo padrao como o 14o harness (o registro MCP via arquivos de bloco YAML em `~/.continue/mcpServers/` chegou separadamente na #564).

## O que "suportado" garante

Para todos os 14 harnesses, o EGC garante:

- O caminho de instalacao esta documentado acima
- Registro do servidor MCP (se a ferramenta suportar MCP)
- Injecao do protocolo de memoria (as instrucoes `get_state` / `update_state` chegam a IA)
- Existe um caminho de desinstalacao

Somente para Nivel 1 e Nivel 2:

- Skills, agentes e regras sao publicados no sistema de arquivos da ferramenta
- A ferramenta pode invocar workflows definidos pelo EGC diretamente

Somente para Nivel 1:

- Um unico pipeline produz todos os targets
- Testes de conformidade validam a saida da instalacao (veja `tests/spec/`)
- Metadados de procedencia sao registrados para cada arquivo materializado

## Lendo a saida do harness-audit

`node scripts/harness-audit.js` produz um relatorio pontuado contra as 7 categorias definidas em `CATEGORIES`. A pontuacao reflete a saude no nivel do repositorio, nao a saude por harness. Uma melhoria futura e o rollup por harness (veja `docs/spec/README.md` Proximos Passos).

## Adicionando um 15o harness

Escolha o nivel com base no que a ferramenta target realmente consome:

1. **Somente MCP e arquivos de instrucoes?** Nivel 3. Adicione o registro MCP em `install.sh` e um nome de target em `scripts/bootstrap-cognitive.js`. ~50 linhas de mudancas.
2. **Skills/agentes/regras no sistema de arquivos + layout customizado?** Nivel 2. Crie `.{ferramenta}/install.sh` seguindo o formato do Kiro/Trae. ~200 linhas.
3. **Skills/agentes/regras no sistema de arquivos + layout canonico?** Nivel 1. Adicione a `SUPPORTED_INSTALL_TARGETS` em `scripts/lib/install-manifests.js`, defina as entradas do manifesto. ~50 linhas de configuracao, nenhum novo caminho de codigo.

O Nivel 1 e preferido quando possivel. O Nivel 2 e aceitavel para ferramentas com layouts de ativos nao padrao. O Nivel 3 e a resposta certa para thin clients.

## Lacunas conhecidas (descobertas de auditoria 2026-06-10)

- Kiro e Trae sao Nivel 2 porque sao anteriores ao pipeline unificado. Poderiam ser migrados para o Nivel 1 com ~6 a 8h de trabalho cada
- `harness-audit` pontua o repositorio, nao os harnesses individuais -- o rollup por harness e o proximo passo de maturacao
