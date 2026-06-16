# Arquitetura Entre Harnesses

egc e a camada de fluxo de trabalho reutilizavel. Harnesses sao superficies de execucao.

O objetivo e manter as partes duraveis do trabalho agentivo em um unico repositorio:

- skills
- regras e instrucoes
- hooks onde o harness os suporta
- configuracao MCP
- manifestos de instalacao
- padroes de sessao e orquestracao

Gemini Code, Codex, OpenCode, Cursor, Gemini e futuros harnesses devem adaptar esses ativos na borda em vez de exigir um novo modelo de fluxo de trabalho para cada ferramenta.

## Modelo de Portabilidade

| Superficie | Fonte Compartilhada | Adaptador de Harness | Status Atual |
|------------|--------------------|-----------------------|--------------|
| Skills | `skills/*/SKILL.md` | plugin gemini, plugin Codex, `.agents/skills`, copias de skills do Cursor, plugin/config OpenCode | Suportado com empacotamento especifico por harness |
| Regras e instrucoes | `rules/`, `AGENTS.md`, docs traduzidos | instalacao de regras gemini, `AGENTS.md` do Codex, regras do Cursor, instrucoes OpenCode | Suportado, mas nao identico entre harnesses |
| Hooks | `hooks/hooks.json`, `scripts/hooks/` | hooks nativos gemini, eventos de plugin OpenCode, adaptador de hook do Cursor | Respaldado por hook em gemini/OpenCode/Cursor; respaldado por instrucao no Codex |
| MCPs | `.mcp.json`, `mcp-configs/` | Importacao de configuracao MCP nativa por harness | Suportado onde o harness expoe MCP |
| Comandos | `commands/`, scripts CLI | comandos slash gemini, shims de compatibilidade, entrypoints CLI | Suportado, mas semantica de comandos varia |
| Sessoes | `egc2/`, adaptadores de sessao, scripts de orquestracao | TUI/daemon, orquestracao tmux/worktree, runners especificos por harness | Alpha |

## O que Viaja Sem Alteracao

`SKILL.md` e a unidade mais portavel.

Uma boa skill egc deve:

- usar frontmatter YAML com `name`, `description` e `origin`
- descrever quando usar a skill
- declarar ferramentas ou conectores necessarios sem embutir segredos
- manter exemplos relativos ao repositorio ou genericos
- evitar suposicoes de comandos exclusivos do harness, a menos que a secao esteja claramente rotulada

A mesma skill de origem pode ser instalada em multiplos harnesses porque e principalmente instrucoes, restricoes e forma de fluxo de trabalho.

## O que e Adaptado

Cada harness tem comportamento diferente de carregamento e aplicacao:

- Gemini Code carrega ativos de plugin e tem execucao nativa de hooks.
- Codex le `AGENTS.md`, metadados de plugin, skills e configuracao MCP de referencia, mas a paridade de hooks e respaldada por instrucoes.
- OpenCode tem um sistema de plugin/evento que pode reutilizar logica de hook do egc por meio de uma camada de adaptador.
- Cursor usa seu proprio layout de regras e hooks, entao o egc mantem superficies traduzidas em `.cursor/`.
- O suporte ao Gemini e orientado a instalacao/instrucao e deve ser tratado como uma superficie de compatibilidade, nao como paridade completa de hooks.

Adaptadores devem ser finos. O comportamento compartilhado pertence a `skills/`, `rules/`, `hooks/`, `scripts/` e `mcp-configs/`.

## Fronteira do Hermes

Hermes nao e o runtime publico do egc.

Hermes e um shell operacional que pode consumir ativos do egc:

- importar skills selecionadas do egc em um diretorio de skills do Hermes
- usar convencoes MCP do egc para acesso a ferramentas
- rotear fluxos de trabalho de chat, CLI, cron e handoff por padroes reutilizaveis do egc
- destilar trabalho operacional local repetido de volta em skills sanitizadas do egc

O repositorio publico deve publicar padroes reutilizaveis, nao estado local do Hermes.

Publique:

- documentos de configuracao sanitizados
- prompts de demonstracao relativos ao repositorio
- skills gerais de operador
- exemplos que nao dependem de credenciais privadas

Nao publique:

- tokens OAuth ou chaves de API
- exportacoes brutas de `~/.hermes`
- memoria pessoal de workspace
- datasets privados
- pacotes de automacao so-locais que nao foram revisados

## Exemplo Pratico

Use `skills/hermes-imports/SKILL.md` como a mesma fonte de skill entre harnesses.

O fluxo de trabalho e:

1. Escreva o comportamento duravel uma vez em `skills/hermes-imports/SKILL.md`.
2. Mantenha segredos, caminhos locais e memoria bruta de operador fora da skill.
3. Deixe cada harness adaptar como a skill e carregada.
4. Teste a skill de origem e os metadados voltados para o harness separadamente.

Gemini Code recebe a skill pela superficie de plugin gemini e pode aplicar hooks relacionados nativamente.

Codex le as instrucoes do repositorio, `.codex-plugin/plugin.json` e a configuracao MCP de referencia. A mesma skill de origem ainda descreve o fluxo de trabalho, mas a paridade de hooks e respaldada por instrucoes, a menos que Codex adicione uma superficie nativa de hooks.

OpenCode recebe a skill pela superficie de pacote/plugin OpenCode. O tratamento de eventos pode reutilizar logica de hook do egc pela camada de adaptador, enquanto o texto da skill permanece inalterado.

Se uma mudanca requer editar tres copias do mesmo fluxo de trabalho em diferentes harnesses, a fonte compartilhada esta no lugar errado. Coloque o fluxo de trabalho de volta em `skills/`, depois adapte apenas o carregamento, a forma do evento ou o roteamento de comandos na borda do harness.

## Hoje vs Depois

Suportado hoje:

- fonte de skill compartilhada em `skills/`
- empacotamento de plugin Gemini Code
- metadados de plugin Codex e configuracao MCP de referencia
- superficie de pacote/plugin OpenCode
- regras, hooks e skills adaptados para Cursor
- `egc2/` como plano de controle Rust em alpha

Ainda amadurecendo:

- paridade exata de hooks entre todos os harnesses
- sincronizacao automatica de skills no Hermes
- empacotamento de release para `egc2/`
- semantica de retomada de sessao entre harnesses
- camadas mais profundas de memoria e planejamento de operador

## Regra para Novo Trabalho

Ao adicionar um fluxo de trabalho, coloque o comportamento duravel no egc primeiro.

Use arquivos especificos de harness apenas para:

- carregar o ativo compartilhado
- adaptar formas de eventos
- mapear nomes de comandos
- lidar com limites de plataforma

Se um fluxo de trabalho so funciona em um harness, documente essa fronteira diretamente.
