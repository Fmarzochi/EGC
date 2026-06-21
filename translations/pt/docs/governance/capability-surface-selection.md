# Selecao de Superficie de Capacidade

Use isto como guia de roteamento ao decidir se uma capacidade pertence a uma rule, uma skill, um servidor MCP ou um fluxo de trabalho CLI/API simples.

O EGC nao trata essas superficies como intercambiaveis. O objetivo e colocar cada capacidade na superficie mais estreita que preserva a corretude, mantem o custo de tokens sob controle e nao cria arrasto de runtime ou cadeia de suprimentos desnecessario.

## O Resumo

- `rules/` sao para restricoes deterministicas e sempre ativas que devem ser injetadas quando um caminho ou evento corresponder.
- `skills/` sao para fluxos de trabalho sob demanda, playbooks mais ricos e orientacao com alto custo de tokens que deve carregar apenas quando relevante.
- `MCP` e para capacidades estruturadas interativas que se beneficiam de uma superficie de ferramenta/recurso de longa duracao entre sessoes ou clientes.
- `CLI` local ou scripts de repositorio sao para acoes deterministicas simples que nao precisam de um servidor persistente.
- chamadas de `API` diretas dentro de uma skill sao para acoes remotas estreitas onde um servidor MCP completo seria mais pesado que o problema.

## Ordem de Decisao

Faca estas perguntas em ordem:

1. Isso deve acontecer toda vez que um caminho ou evento corresponder, sem julgamento do modelo?
   - Use uma `rule`.
2. Isso e principalmente um playbook, fluxo de trabalho ou camada de orientacao que deve carregar apenas quando a tarefa realmente precisar?
   - Use uma `skill`.
3. A capacidade precisa de uma interface de ferramenta/recurso interativa estruturada que varios harnesses ou clientes devem chamar repetidamente?
   - Use `MCP`.
4. E uma acao local simples que pode executar como um script sem manter um servidor vivo?
   - Use um ponto de entrada `CLI` local ou script de repositorio, depois embrulhe com uma skill se necessario.
5. E apenas uma etapa de integracao remota estreita dentro de um fluxo de trabalho maior?
   - Chame a `API` externa diretamente da skill ou script.

## Orientacao por Superficie

### Rules

Use rules para:
- invariantes de codificacao com escopo de caminho
- andares de seguranca e restricoes de permissao
- restricoes de harness/runtime que devem sempre se aplicar
- lembretes deterministicos que nao devem depender do criterio do modelo

### Skills

Use skills para:
- fluxos de trabalho de multiplas etapas
- orientacao com muito julgamento
- playbooks de dominio caros o suficiente para carregar apenas sob demanda
- orquestracao entre scripts, APIs, ferramentas MCP e skills adjacentes

### MCP

Use MCP quando a capacidade se beneficia de:
- entradas/saidas estruturadas de ferramentas
- recursos ou prompts reutilizaveis
- uso repetido entre clientes
- uma interface estavel que deve funcionar em Gemini Code, Codex, Cursor, OpenCode e harnesses relacionados

### CLI / Scripts de Repositorio

Prefira um script local ou CLI quando:
- a acao e deterministica
- a inicializacao e barata
- o fluxo de trabalho e principalmente local
- nao ha beneficio em expor uma superficie de ferramenta/recurso persistente

## Heuristica Pratica

Em caso de duvida, comece menor:
- comece com uma `rule` para invariantes deterministicas
- comece com uma `skill` para orientacao/fluxo de trabalho
- comece com um script para execucao de uso unico
- promova para `MCP` apenas quando o limite estruturado do servidor estiver claramente valendo a pena
