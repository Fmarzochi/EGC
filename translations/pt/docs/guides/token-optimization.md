# Guia de Otimizacao de Tokens

Configuracoes e habitos praticos para reduzir o consumo de tokens, estender a qualidade da sessao e fazer mais dentro dos limites diarios.

> Veja tambem: `rules/common/performance.md` para estrategia de selecao de modelo, `skills/strategic-compact/` para sugestoes automaticas de compactacao.

---

## Configuracoes Recomendadas

Essas sao as configuracoes padrao recomendadas para a maioria dos usuarios. Usuarios avancados podem ajustar os valores com base em sua carga de trabalho: por exemplo, definindo `MAX_THINKING_TOKENS` menor para tarefas simples ou maior para trabalho arquitetural complexo.

Adicione ao seu `~/.gemini/settings.json`:

```json
{
  "model": "sonnet",
  "env": {
    "MAX_THINKING_TOKENS": "10000",
    "gemini_CODE_SUBAGENT_MODEL": "haiku"
  }
}
```

### O que cada configuracao faz

| Configuracao | Padrao | Recomendado | Efeito |
|--------------|--------|-------------|--------|
| `model` | gemini-2.5-pro | **sonnet** | Sonnet lida bem com ~80% das tarefas de codificacao. Mude para gemini-2.5-pro com `/model gemini-2.5-pro` para raciocinio complexo. Reducao de custo de ~60%. |
| `MAX_THINKING_TOKENS` | 31.999 | **10.000** | O pensamento estendido reserva ate 31.999 tokens de saida por requisicao para raciocinio interno. Reduzir isso corta o custo oculto em ~70%. Defina como `0` para desabilitar em tarefas triviais. |
| `gemini_CODE_SUBAGENT_MODEL` | _(herda principal)_ | **haiku** | Subagentes (ferramenta Task) rodam neste modelo. Haiku e ~80% mais barato e suficiente para exploracao, leitura de arquivos e execucao de testes. |

### Nota da comunidade sobre substituicoes de auto-compactacao

Algumas versoes recentes do Gemini Code tem relatos da comunidade de que `gemini_AUTOCOMPACT_PCT_OVERRIDE` pode somente diminuir o limite de compactacao, o que significa que valores abaixo do padrao podem compactar mais cedo em vez de mais tarde. Se isso acontecer na sua configuracao, remova a substituicao e confie no `/compact` manual mais o guia `strategic-compact` do egc. Veja [Solucao de Problemas](./TROUBLESHOOTING.md).

### Alternando pensamento estendido

- **Alt+T** (Windows/Linux) ou **Option+T** (macOS): alternar ligado/desligado
- **Ctrl+O**: ver saida de pensamento (modo verbose)

---

## Selecao de Modelo

Use o modelo certo para a tarefa:

| Modelo | Melhor para | Custo |
|--------|-------------|-------|
| **Haiku** | Exploracao com subagente, leitura de arquivos, buscas simples | Menor |
| **Sonnet** | Codificacao diaria, revisoes, escrita de testes, implementacao | Medio |
| **gemini-2.5-pro** | Arquitetura complexa, raciocinio em multiplos passos, depuracao de problemas sutis | Maior |

Mude de modelo durante a sessao:

```
/model sonnet     # padrao para a maioria dos trabalhos
/model gemini-2.5-pro       # raciocinio complexo
/model haiku      # buscas rapidas
```

---

## Gerenciamento de Contexto

### Comandos

| Comando | Quando usar |
|---------|-------------|
| `/clear` | Entre tarefas nao relacionadas. Contexto antigo desperdicao tokens em cada mensagem subsequente. |
| `/compact` | Em pontos logicos de tarefa (apos planejamento, apos depuracao, antes de mudar de foco). |
| `/cost` | Verificar gasto de tokens para a sessao atual. |

### Compactacao estrategica

A skill `strategic-compact` (em `skills/strategic-compact/`) sugere `/compact` em intervalos logicos em vez de depender da auto-compactacao, que pode disparar no meio de uma tarefa. Veja o README da skill para instrucoes de configuracao de hook.

**Quando compactar:**
- Apos exploracao, antes de implementacao
- Apos concluir um marco
- Apos depuracao, antes de continuar com novo trabalho
- Antes de uma mudanca importante de contexto

**Quando NAO compactar:**
- No meio de implementacao de mudancas relacionadas
- Enquanto depura um problema ativo
- Durante refatoracao de multiplos arquivos

### Subagentes protegem seu contexto

Use subagentes (ferramenta Task) para exploracao em vez de ler muitos arquivos na sua sessao principal. O subagente le 20 arquivos mas retorna apenas um resumo: seu contexto principal fica limpo.

---

## Comprimindo Observacoes

O EGC registra eventos brutos de hook (chamadas de ferramentas, edicoes de arquivos, erros) no banco de dados do state-store. Com o tempo, eles se acumulam. A ferramenta MCP `compress_observations` os processa em resumos tipados:

```
compress_observations({ limit: 50 })
```

Isso substitui registros brutos verbosos por entradas compactas como `tool_failure`, `tool_success` e `file_edit`, reduzindo drasticamente o custo de tokens de injetar historico em uma nova sessao. Execute-a em pontos logicos de sessao ou quando a contagem de observacoes crescer muito.

---

## Gerenciamento de Servidores MCP

Cada servidor MCP habilitado adiciona definicoes de ferramentas a sua janela de contexto. O README avisa: **mantenha abaixo de 10 habilitados por projeto**.

Dicas:
- Execute `/mcp` para ver servidores ativos e seu custo de contexto
- Use `/mcp` para desabilitar servidores MCP do Gemini Code quando quiser uma mudanca ao vivo. O Gemini Code persiste essas desativacoes de runtime em `~/.gemini.json`.
- Prefira ferramentas CLI quando disponiveis (`gh` em vez de GitHub MCP, `aws` em vez de AWS MCP)
- Nao confie em `.gemini/settings.json` ou `.gemini/settings.local.json` para desabilitar servidores MCP do Gemini Code ja carregados; use `/mcp` para isso.
- `EGC_DISABLED_MCPS` afeta apenas a saida de configuracao MCP gerada pelo EGC durante fluxos de instalacao/sincronizacao. Nao e uma alternancia ao vivo do Gemini Code.
- O servidor MCP `memory` e configurado por padrao mas nao e usado por nenhuma skill, agente ou hook: considere desabilitá-lo.

---

## Aviso de Custo de Equipes de Agentes

[Equipes de Agentes](https://code.gemini.com/docs/en/agent-teams) (experimental) cria multiplas janelas de contexto independentes. Cada membro consome tokens separadamente.

- Use apenas para tarefas onde o paralelismo agrega valor claro (trabalho em multiplos modulos, revisoes paralelas)
- Para tarefas sequenciais simples, subagentes (ferramenta Task) sao mais eficientes em tokens
- Habilite com: `gemini_CODE_EXPERIMENTAL_AGENT_TEAMS=1` nas configuracoes

---

## Futuro: Integracao configure-egc

O assistente de instalacao `configure-egc` poderia oferecer a configuracao dessas variaveis de ambiente durante a configuracao, com explicacoes das trocas de custo. Isso ajudaria novos usuarios a otimizar desde o primeiro dia em vez de descobrir essas configuracoes apos atingir limites.

---

## Referencia Rapida

```bash
# Fluxo de trabalho diario
/model sonnet              # Comece aqui
/model gemini-2.5-pro      # Somente para raciocinio complexo
/clear                     # Entre tarefas nao relacionadas
/compact                   # Em pontos logicos
/cost                      # Verificar gasto

# Variaveis de ambiente (adicionar ao bloco "env" de ~/.gemini/settings.json)
MAX_THINKING_TOKENS=10000
gemini_CODE_SUBAGENT_MODEL=haiku
gemini_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```
