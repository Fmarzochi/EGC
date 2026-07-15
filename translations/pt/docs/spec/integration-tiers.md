# Camadas de Integração do EGC

> O mapa honesto de como cada ferramenta de codificação com IA suportada se integra ao EGC.

O EGC suporta 19 ferramentas de codificação com IA através de 3 mecanismos de integração distintos. Este documento é a fonte da verdade sobre o que está e o que não está integrado, e em que profundidade.

## Definições de camada

| Camada | Nome | O que é entregue | Pipeline de instalação |
|------|------|------------|------------------|
| **1** | Unificada completa | Skills, agentes, regras, hooks, MCP, manifesto de instalação | `scripts/install-apply.js` via `SUPPORTED_INSTALL_TARGETS` |
| **2** | Script customizado | Assets específicos da ferramenta via instalador dedicado | `.{tool}/install.sh` chamado a partir de `install.sh` |
| **3** | Somente protocolo | Registro de servidor MCP + injeção do protocolo de memória | `scripts/bootstrap-cognitive.js` + registro MCP em `install.sh` |

## As 19 ferramentas

| # | Ferramenta | Camada | Target id | Caminho de instalação | Notas |
|---|------|------|-----------|--------------|-------|
| 1 | **Claude Code** | 1 | `claude` | `~/.claude/skills/<name>/SKILL.md` | Skills instaladas de forma plana; MCP + bootstrap cognitivo via `~/.claude/CLAUDE.md` |
| 2 | **Antigravity (AGY)** | 1 | `antigravity` | `.agents/` (escopo de projeto, por repositório) | Skills, agentes, regras e comandos instalados por projeto; hooks do GateGuard registrados; sem target de nível home (Antigravity não tem descoberta global de regras) |
| 3 | **Gemini CLI** | 1 | `gemini` | `~/.gemini/` | Bootstrap cognitivo em `GEMINI.md` |
| 4 | **Cursor** | 1 | `cursor` | `~/.cursor/` | Regras injetadas no cursor.rules global |
| 5 | **Codex CLI** | 1 | `codex` | `~/.agents/skills/<name>/SKILL.md` | Skills instaladas de forma plana; `persistent_instructions` anexadas |
| 6 | **OpenCode** | 1 | `opencode` | `~/.config/opencode/skills/<name>/SKILL.md` | Eventos nativos de plugin para hooks |
| 7 | **CodeBuddy** | 1 | `codebuddy` | `.codebuddy/skills/<name>/SKILL.md` | Injeção de contexto |
| 8 | **Windsurf** | 1 | `windsurf` | `~/.codeium/windsurf/skills/<name>/SKILL.md` | Skills instaladas de forma plana |
| 9 | **Amp** | 1 | `amp` | `~/.amp/skills/<name>/SKILL.md` | Skills instaladas de forma plana |
| 10 | **VS Code Copilot** | 1 | `copilot` | `~/.github/skills/<name>/SKILL.md` | Skills instaladas de forma plana |
| 11 | **Zed** | 1 | `zed` | `~/.config/zed/skills/<name>/` | Skills instaladas de forma plana (categoria removida); MCP via `context_servers` em `settings.json`; bootstrap cognitivo em `~/.config/zed/AGENTS.md` |
| 12 | **Continue.dev** | 1 | `continue` | `~/.continue/skills/<name>/SKILL.md` | Skills instaladas de forma plana; MCP via arquivos de bloco YAML em `~/.continue/mcpServers/`; prompt do protocolo de memória em `~/.continue/prompts/`; regras descobertas nativamente em `.continue/rules/` do workspace |
| 13 | **Kiro** | 1 | `kiro` | `~/.kiro/skills/<name>/` (home) e `.kiro/skills/<name>/` (projeto) | Skills instaladas de forma plana via o pipeline unificado; o script legado `.kiro/install.sh` ainda cuida de agentes, documentos de steering, hooks, scripts e configurações específicos do projeto (uma responsabilidade separada da distribuição de skills, ainda não migrada) |
| 14 | **Trae** | 1 | `trae` | `.trae/skills/<name>/` (somente projeto, sem target home) | Skills instaladas de forma plana via o pipeline unificado; o script legado `.trae/install.sh` ainda cuida de comandos, agentes, regras e do protocolo de memória `~/.trae/MEMORY.md` (somente escopo de projeto; `TRAE_ENV=cn` para `~/.trae-cn/`) |
| 15 | **Goose** | 1 | `goose` | `~/.agents/skills/<name>/SKILL.md` (compartilhado com Codex) | Skills instaladas de forma plana; sem wiring de hook do GateGuard (Goose não tem API de hook documentada); adapter somente de descoberta sobre a mesma raiz `~/.agents` que `codex-home.js` já escreve |
| 16 | **Amazon Q Developer CLI** | 1 | `amazonq` | `.amazonq/rules/` (somente projeto, sem target home) | Scaffold padrão (categoria preservada), mesmo template de `gemini-project.js`; sem wiring de hook |
| 17 | **OpenHands** | 1 | `openhands` | `~/.agents/skills/<name>/SKILL.md` (compartilhado com Codex/Goose) | Skills instaladas de forma plana; sem wiring de hook do GateGuard; adapter somente de descoberta -- a issue original pedia `.openhands/microagents/`, mas a documentação atual do OpenHands recomenda o caminho padrão AgentSkills `.agents/skills/<name>/SKILL.md` (o legado `.openhands/microagents/` ainda funciona, mas não é mais o target documentado), então este adapter espelha o do Goose |
| 18 | **Aider** | 1 | `aider` | `.aider/skills/<name>.md` (somente projeto, sem target home) | Skills copiadas de forma plana como arquivos `.md` únicos (Aider não escaneia uma convenção de pasta de skill); o caminho de cada arquivo é mesclado na lista `read:` de `.aider.conf.yml` via um novo operation kind `merge-yaml-read-list`, preservando quaisquer chaves existentes não relacionadas; install/repair/uninstall totalmente conectados |
| 19 | **Warp** | 1 | `warp` | `.warp/skills/<name>.md` + índice na raiz do projeto `AGENTS.md` (somente projeto, sem target home) | Warp só descobre um único arquivo raiz `AGENTS.md`/`WARP.md` como regras de projeto, não um diretório de arquivos de skill -- confirmado que um `AGENTS.md` simples é suficiente (a própria documentação do Warp o chama de arquivo padrão de regras de projeto; `WARP.md` é legado e só tem prioridade se ambos existirem). O conteúdo completo da skill é copiado de forma plana para `.warp/skills/<name>.md` (lido sob demanda); um índice curto (nome + descrição de uma linha + caminho) é mesclado em um bloco marcado dentro de `AGENTS.md` via um novo operation kind `merge-markdown-skill-index`, já que concatenar todas as 230+ skills (~2MB) no arquivo de regras sempre carregado estouraria o orçamento de contexto. Install/repair/uninstall totalmente conectados; o uninstall nunca apaga o próprio `AGENTS.md`, só o bloco do EGC |

## Por que três camadas (história, não aspiração)

A Camada 1 (unificada) é o pipeline canônico. É o resultado de `install-plan.js` resolvendo manifestos de instalação contra `SUPPORTED_INSTALL_TARGETS`, e depois `install-apply.js` materializando os arquivos. O pipeline emite proveniência, suporta dry-run e é coberto por mais de 200 testes em `tests/`.

A Camada 2 (script customizado) existe porque Kiro e Trae chegaram ao EGC antes do pipeline unificado estar estável. Seus instaladores fazem aproximadamente o mesmo trabalho que o pipeline unificado, mas o formato dos assets que entregam difere o suficiente pra tornar a retrofitagem não trivial. Ambos são de primeira classe, mas tecnicamente isolados. A distribuição de skills de Kiro e Trae já foi migrada pra Camada 1 (target ids `kiro` e `trae`); seus assets que não são skills (Kiro: agentes/steering/hooks/configurações; Trae: comandos/agentes/regras/protocolo de memória) ainda são entregues pelos scripts originais `.{tool}/install.sh`.

A Camada 3 (somente protocolo) é o ponto de entrada pra qualquer ferramenta que suporte MCP. Claude Code já foi Camada 3, mas agora suporta `~/.claude/skills/<name>/SKILL.md` como caminho de descoberta de skill, então foi promovido pra Camada 1 com target id `claude`. Windsurf, Amp e VS Code Copilot foram adicionados como targets de Camada 1 na v1.0.2 seguindo o mesmo padrão de descoberta de skill. Continue.dev seguiu o mesmo padrão como a 14ª ferramenta (seu registro MCP via arquivos de bloco YAML em `~/.continue/mcpServers/` chegou separadamente na #564).

## O que "suportado" garante

Para as 19 ferramentas, o EGC garante:

- O caminho de instalação está documentado acima
- Registro de servidor MCP (se a ferramenta suportar MCP)
- Injeção do protocolo de memória (as instruções `get_state` / `update_state` chegam à IA)
- Existe um caminho de desinstalação

Somente para Camada 1 e Camada 2:

- Skills, agentes e regras são entregues ao sistema de arquivos da ferramenta
- A ferramenta pode invocar workflows definidos pelo EGC diretamente

Somente para Camada 1:

- Um único pipeline produz todos os targets
- Testes de conformidade validam a saída da instalação (veja `tests/spec/`)
- Metadados de proveniência são registrados para cada arquivo materializado

## Lendo a saída do harness-audit

`node scripts/harness-audit.js` produz um relatório pontuado contra as 7 categorias definidas em `CATEGORIES`. A pontuação reflete a saúde do repositório, não a saúde de cada ferramenta individualmente. Um aprimoramento futuro é o rollup por ferramenta (veja os Próximos Passos em `docs/spec/README.md`).

## Adicionando uma nova ferramenta

Escolha a camada baseado no que a ferramenta alvo realmente consome:

1. **Só MCP e arquivos de instrução?** Camada 3. Adicione o registro MCP em `install.sh` e um nome de target em `scripts/bootstrap-cognitive.js`. ~50 linhas de mudanças.
2. **Skills/agentes/regras no sistema de arquivos + layout customizado?** Camada 2. Crie `.{tool}/install.sh` seguindo o formato de Kiro/Trae. ~200 linhas.
3. **Skills/agentes/regras no sistema de arquivos + layout canônico?** Camada 1. Adicione a `SUPPORTED_INSTALL_TARGETS` em `scripts/lib/install-manifests.js`, defina as entradas do manifesto. ~50 linhas de configuração, sem novo caminho de código.

A Camada 1 é preferida sempre que possível. A Camada 2 é aceitável para ferramentas com layouts de assets fora do padrão. A Camada 3 é a resposta certa para clientes leves.

## Lacunas conhecidas (achados de auditoria de 2026-06-10)

- A distribuição de skills de Kiro e Trae migrou para Camada 1 (veja as linhas 13-14); os assets que não são skills de cada ferramenta permanecem no caminho legado `.{tool}/install.sh`
- `harness-audit` pontua o repositório, não ferramentas individuais -- o rollup por ferramenta é o próximo passo de maturação
