<!-- LANGUAGE-SELECTOR-START -->
**Idioma:** [English](../../README.md) | [العربية](../ar/README.md) | [Español](../es/README.md) | **Português (Brasil)** | [हिन्दी](../hi/README.md) | [한국어](../ko/README.md) | [Русский](../ru/README.md) | [日本語](../ja/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![npm version](https://img.shields.io/npm/v/@egchq/egc?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@egchq/egc) [![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Discord](https://img.shields.io/discord/1513941515452416130?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/AtazrtxJ) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](../../.github/CONTRIBUTING.md) [![Stars](https://img.shields.io/github/stars/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/stargazers) [![Forks](https://img.shields.io/github/forks/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/network/members) [![Issues](https://img.shields.io/github/issues/Fmarzochi/EGC)](https://github.com/Fmarzochi/EGC/issues) [![Maintained](https://img.shields.io/badge/Maintained-yes-brightgreen)](https://github.com/Fmarzochi/EGC/commits/main) [![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC) [![Featured on Product Hunt](https://img.shields.io/badge/Product%20Hunt-featured-DA552F?logo=producthunt&logoColor=white)](https://www.producthunt.com/posts/egc)

<div align="center">

# EGC - Extended Global Context

**Seus agentes de IA nunca mais começarão do zero.**

</div>

---

EGC é um runtime local que oferece memória persistente para cada ferramenta de IA que você usa. Ao final de cada sessão, a IA salva o que aprendeu sobre o seu projeto: as decisões tomadas, o que falhou, suas preferências e os próximos passos. No início da próxima sessão, ela carrega esse estado de volta. Uma única instalação cobre Claude Code, Cursor, Gemini CLI, Windsurf, VS Code com GitHub Copilot e muito mais. Compatível com Claude, GPT-4o, Gemini e modelos OpenRouter, incluindo DeepSeek, Qwen3 e Llama 4.

---

## É assim que o EGC funciona na prática

Você abre o Claude Code em um projeto que não tocou há duas semanas. Sem digitar nada:

```
State loaded from egc-memory via ~/.egc/state/Projects-MyApp.md

Context and preferences acknowledged (terse responses).

Ready to pick up the next items:
• Test full install on a clean machine
• Add GEMINI.md with session memory protocol
• Publish v1.0.1 fix to npm after clean install test passes
• Add mcp_server_count to audit.js

=== EGC Stack Briefing ===
Stack: typescript, javascript
Stack agents: typescript-reviewer, javascript-reviewer
Always use: code-reviewer
Skill: coding-standards (cyclomatic complexity) - apply to all code written this session
===
```

A IA já sabe o que você estava construindo, quais decisões tomou, o que falhou e exatamente onde parou. Ela sabe porque o EGC salvou esse estado ao final da sua última sessão e o carregou de volta quando esta começou. Você não digitou nada. Você simplesmente começou a trabalhar.

<div align="center">
  <img src="../../assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## Instalação

```bash
npm install -g @egchq/egc && egc install
```

Ou execute sem instalar globalmente:

```bash
npx @egchq/egc install
```

[Guia de instalação completo](../../docs/installation.md)

### VS Code + GitHub Copilot

Use o target Copilot quando quiser as skills do EGC disponíveis no VS Code via GitHub Copilot Chat:

```bash
npm install -g @egchq/egc
egc install --target copilot
```

Requer a extensão GitHub Copilot Chat. O EGC instala as skills em `~/.github/skills/`, onde o Copilot as descobre automaticamente. O mesmo estado de memória é compartilhado com Claude Code, Cursor, Gemini CLI, Windsurf e outros targets do EGC.

---

## O que o EGC oferece à sua IA

O EGC inclui dois servidores MCP que trabalham juntos durante cada sessão.

**`egc-memory`** - 14 ferramentas para memória persistente:

| Ferramenta | O que faz |
|---|---|
| `get_state` | Carrega a memória do projeto no início da sessão |
| `update_state` | Salva decisões, preferências e próximos passos |
| `store_decision` | Persiste uma única decisão no SQLite |
| `query_history` | Retorna decisões anteriores por timestamp |
| `search_history` | Busca em texto completo com ranking BM25 |
| `working_memory_set` | Armazena contexto transitório com TTL |
| `working_memory_get` | Lê uma chave transitória |
| `working_memory_list` | Lista todas as entradas transitórias ativas do projeto atual |
| `lesson_save` | Registra conhecimento entre sessões com decaimento de confiança |
| `lesson_recall` | Recupera lições ativas acima de um limite de confiança |
| `lesson_reinforce` | Aumenta a confiança em uma lição quando o mesmo padrão se repete |
| `detect_patterns` | Identifica comandos repetidos e erros recorrentes a partir de eventos de hook |
| `compress_observations` | Comprime observações brutas em resumos tipados para reduzir o uso de tokens |
| `get_project_state` | Retorna metadados de saúde do servidor e status do mecanismo de armazenamento |

Os arquivos de estado ficam em `~/.egc/state/<project-slug>.md`. Um arquivo por projeto, Markdown simples, legível por humanos.

**`egc-guardian`** - 5 ferramentas para contexto e segurança:

| Ferramenta | O que faz |
|---|---|
| `validate_command` | Verifica comandos de shell contra as regras de segurança do projeto antes da execução |
| `validate_write` | Valida caminhos de escrita para prevenir gravações inseguras |
| `reduce_context` | Comprime payloads de arquivos para economizar seu orçamento de tokens |
| `orchestrate_task` | Roteia prompts com contexto de agentes/skills e retorna métricas de compressão |
| `auto_learn` | Analisa falhas de sessão e escreve lições acionáveis em todos os arquivos de configuração de ferramentas de IA do projeto |

**`egc watch`** - daemon de sincronização bidirecional. Monitora todos os arquivos de configuração de ferramentas gerenciados pelo EGC no projeto. Quando você edita o contexto diretamente em qualquer arquivo de ferramenta (Cursor, Gemini CLI, Copilot, etc.), a mudança é extraída do bloco EGC e sincronizada com todas as outras ferramentas e de volta para `~/.egc/state/` automaticamente.

```
egc watch              # monitorar projeto atual
egc watch /caminho     # monitorar projeto específico
egc watch --quiet      # suprimir saída
```

### Aplicado por código, não por pedido

A validação não depende de a IA escolher cooperar. O EGC instala hooks no harness que rodam em toda chamada de ferramenta: cada comando de shell e cada escrita de arquivo é validada antes de executar, e comandos destrutivos, caminhos de credenciais e force-push são bloqueados mesmo dentro de comandos compostos. Todo prompt também é roteado contra o catálogo de componentes, injetando no contexto as skills e os agents certos. Se o validador estiver ausente, os hooks falham abertos: você nunca fica trancado fora da sua própria ferramenta.

Com uma API key de provider (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` ou `OPENROUTER_API_KEY`), o EGC também entende a intenção da sessão semanticamente, em qualquer idioma, sem frases pré-definidas: diga que vai encerrar por hoje e o estado é salvo antes mesmo de a IA responder; cumprimente na manhã seguinte e os próximos passos já estão no contexto. Ao fim da sessão, um minerador de memória destila as decisões e lições da sessão para o estado do projeto. Sem key, esses recursos de LLM honestamente não fazem nada, e os hooks de ciclo de vida continuam garantindo o salvamento do estado.

### Dashboard - painel de controle em tempo real

Veja cada chamada de ferramenta, token e custo gerado pelos seus agentes -- ao vivo no navegador. Inicia automaticamente após `egc init`. [Guia completo](docs/installation.md#dashboard)

---

## Biblioteca de prompts

**479 componentes** inclusos como brinde: 63 agentes, 229 skills, 76 comandos e 111 regras escritos em sessoes reais de engenharia. Ignore-os completamente e o EGC ainda oferece memoria persistente.

---

## Apoie o EGC

O EGC é desenvolvido por um único desenvolvedor, mantido de forma aberta e gratuito.

- **[Entre no Discord](https://discord.gg/AtazrtxJ)**: faça perguntas, compartilhe feedback
- **[Patrocine no GitHub](https://github.com/sponsors/Fmarzochi)**: qualquer valor ajuda
- **[Doe pelo PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: sem necessidade de conta no GitHub
- **Marque o repositório com estrela**: ajuda outros desenvolvedores a encontrá-lo
- **[Contribua](../../.github/CONTRIBUTING.md)**: agentes, skills, comandos, correções de bugs, documentação
- **Compartilhe**: se o EGC mudou sua forma de trabalhar, conte para alguém

### Patrocinadores

O apoio da comunidade mantém este projeto vivo e independente.

#### Parceiros de ferramentas

Ferramentas de programacao com IA que se integram nativamente com o EGC. Os parceiros recebem espaco para logo em todos os READMEs e no EGCSite.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### Patrocinadores anuais · _Seja o primeiro patrocinador anual._

---

#### Apoiadores

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### Patrocinadores mensais · _seja o primeiro_

---

<div align="center">

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
