# Configuracao Hermes x egc

Hermes e o shell operacional. egc e a base reutilizavel por tras dele.

Este guia e a versao publica e sanitizada da stack do Hermes usada para executar conteudo, alcance, pesquisa, operacoes de vendas, verificacoes financeiras e fluxos de trabalho de engenharia a partir de uma interface nativa de terminal.

## O que e Publicado Publicamente

- Skills, agentes, comandos, hooks e configuracoes MCP do egc deste repositorio
- Skills de fluxo de trabalho geradas pelo Hermes que sao estaveis o suficiente para reutilizacao
- Uma topologia de operador documentada para chat, crons, memoria de workspace e fluxos de distribuicao
- Material de lancamento para compartilhar a stack publicamente

Este guia nao inclui segredos privados, tokens ativos, dados pessoais nem uma exportacao bruta de `~/.hermes`.

## Arquitetura

Use o Hermes como porta de entrada e o egc como substrato de fluxo de trabalho reutilizavel.

```text
Telegram / CLI / TUI
        ↓
      Hermes
        ↓
 egc skills + hooks + MCPs + pacotes de fluxo de trabalho gerados
        ↓
 Google Drive / GitHub / automacao de navegador / APIs de pesquisa / ferramentas de midia / ferramentas financeiras
```

## Mapa Publico de Workspace

Use isso como a superficie minima para reproduzir a configuracao sem vazar estado privado.

- `~/.hermes/config.yaml`
  - roteamento de modelos
  - registro de servidores MCP
  - carregamento de plugins
- `~/.hermes/skills/egc-imports/`
  - skills do egc copiadas para uso nativo no Hermes
- `skills/hermes-generated/`
  - padroes de operador destilados de sessoes repetidas do Hermes
- `~/.hermes/plugins/`
  - plugins de bridge para hooks, lembretes e cola de ferramentas especificas de fluxo de trabalho
- `~/.hermes/cron/jobs.json`
  - execucoes de automacao agendadas com prompts e canais explicitos
- `~/.hermes/workspace/`
  - artefatos de negocios, ops, saude, conteudo e memoria

## Stack de Capacidades Recomendado

### Core

- Hermes para chat, cron, orquestracao e estado de workspace
- egc para skills, regras, prompts e convencoes entre harnesses
- GitHub + Context7 + Exa + Firecrawl + Playwright como a camada MCP base

### Conteudo

- FFmpeg para edicao e montagem local
- Remotion para clipes programaveis
- fal.ai para geracao de imagem/video
- ElevenLabs para voz, limpeza e empacotamento de audio
- CapCut ou VectCutAPI para polimento final para redes sociais

### Operacoes de Negocios

- Google Drive como sistema de registro para docs, planilhas, apresentacoes e dumps de pesquisa
- Stripe para operacoes de receita e pagamento
- GitHub para execucao de engenharia
- Canais estilo Telegram e iMessage para notificacoes urgentes e aprovacoes

## O que ainda Requer Autenticacao Local

Esses ficam locais e devem ser configurados por operador:

- Token OAuth do Google para Drive / Docs / Sheets / Slides
- Credenciais de distribuicao X / LinkedIn / outbound
- Chaves Stripe
- Credenciais de automacao de navegador e configuracoes de stealth/proxy
- Quaisquer credenciais de CRM ou sistema de projeto como Linear ou Apollo
- Caminho de exportacao ou ingestao do Apple Health se as automacoes de saude estiverem habilitadas

## Ordem de Inicializacao Sugerida

0. Execute `egc migrate audit --source ~/.hermes` primeiro para inventariar o workspace legado e ver quais partes ja se mapeiam no egc.
0.5. Planeje e construa artefatos de migracao antes de importar qualquer coisa:
   - gere planos revisaveis com `egc migrate plan` e `egc migrate scaffold`
   - construa skills legadas reutilizaveis com `egc migrate import-skills --output-dir migration-artifacts/skills`
   - construa templates de traducao de ferramentas com `egc migrate import-tools --output-dir migration-artifacts/tools`
   - construa templates de plugins de bridge com `egc migrate import-plugins --output-dir migration-artifacts/plugins`
   - visualize jobs recorrentes com `egc migrate import-schedules --dry-run`
   - visualize despacho de gateway com `egc migrate import-remote --dry-run`
   - visualize contexto seguro de env/servico com `egc migrate import-env --dry-run`
   - importe memoria de workspace sanitizada com `egc migrate import-memory`
1. Instale o egc e verifique a configuracao base do harness com `node tests/run-all.js`; o resultado esperado e um resumo de testes sem falhas.
2. Instale o Hermes e aponte para skills importadas do egc.
3. Registre os servidores MCP que voce realmente usa todos os dias.
4. Autentique o Google Drive primeiro, depois o GitHub, depois os canais de distribuicao.
5. Comece com uma superficie de cron pequena: verificacao de prontidao, responsabilidade de conteudo, triagem de inbox, monitor de receita.
6. Somente entao adicione fluxos de trabalho pessoais mais pesados como saude, grafos de relacionamento ou sequenciamento de outbound.

## Documentacao Relacionada

- [Guia de migracao Hermes/OpenClaw](HERMES-OPENCLAW-MIGRATION.md)
- [Arquitetura entre harnesses](architecture/cross-harness.md)

## Por que Hermes x egc

Esta stack e util quando voce quer:

- um lugar nativo de terminal para executar operacoes de negocios e engenharia
- skills reutilizaveis em vez de prompts avulsos
- automacao que pode notificar, auditar e escalar
- um repositorio publico que mostra a forma do sistema sem expor seu estado privado de operador

## Escopo do Release Candidate Publico

O EGC v1.0.0 documenta a superficie do Hermes e publica material de lancamento agora.

As pecas privadas restantes podem ser adicionadas depois:

- templates sanitizados adicionais
- exemplos publicos mais ricos
- mais pacotes de fluxo de trabalho gerados
- integracoes mais estreitas com CRM e Google Workspace
