<div align="center">
<img src="../../assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![npm version](https://img.shields.io/npm/v/@egchq/egc?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@egchq/egc) [![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Discord](https://img.shields.io/discord/1513941515452416130?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/AtazrtxJ) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](../../.github/CONTRIBUTING.md) [![Stars](https://img.shields.io/github/stars/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/stargazers) [![Forks](https://img.shields.io/github/forks/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/network/members) [![Issues](https://img.shields.io/github/issues/Fmarzochi/EGC)](https://github.com/Fmarzochi/EGC/issues) [![Maintained](https://img.shields.io/badge/Maintained-yes-brightgreen)](https://github.com/Fmarzochi/EGC/commits/main) [![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC)

<div align="center">

# EGC - Extended Global Context

**Seus agentes de IA nunca mais comecarao do zero.**

</div>

---

EGC e um runtime local que da a cada ferramenta de IA que voce usa uma memoria persistente. Ao final de cada sessao, a IA salva o que aprendeu sobre o seu projeto: as decisoes tomadas, o que falhou, suas preferencias e o que vem a seguir. No inicio da proxima sessao, ela carrega esse estado de volta. Uma unica instalacao cobre Claude Code, Cursor, Gemini CLI, Windsurf e muito mais.

---

## E assim que o EGC funciona na pratica

Voce abre o Claude Code em um projeto que nao tocou ha duas semanas. Sem digitar nada:

```
State loaded from egc-memory via ~/.egc/state/Projects--MyApp.md

Context and preferences acknowledged (terse responses).

Ready to pick up the next items:
• Test full install on a clean machine
• Add GEMINI.md with session memory protocol
• Publish v1.0.1 fix to npm after clean install test passes
• Add mcp_server_count to audit.js
```

A IA ja sabe o que voce estava construindo, quais decisoes tomou, o que falhou e exatamente onde parou. Ela sabe porque o EGC salvou esse estado ao final da sua ultima sessao e o carregou de volta quando esta comeou. Voce nao digitou nada. Voce simplesmente comeou a trabalhar.

<div align="center">
  <img src="../../assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## Instalacao

```bash
npm install -g @egchq/egc && egc install
```

Ou execute sem instalar globalmente:

```bash
npx @egchq/egc install
```

[Guia de instalacao completo](../../docs/installation.md)

---

## O que o servidor MCP oferece a sua IA

O EGC inclui o `egc-memory`, um servidor MCP que expoe 13 ferramentas que sua IA pode chamar durante uma sessao:

| Ferramenta              | O que faz                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `get_state`             | Carrega a memoria do projeto no inicio da sessao                                     |
| `update_state`          | Salva decisoes, preferencias e proximos passos                                       |
| `store_decision`        | Persiste uma unica decisao no SQLite                                                 |
| `query_history`         | Retorna decisoes anteriores por timestamp                                            |
| `search_history`        | Busca em texto completo com ranking BM25                                             |
| `set_working_memory`    | Armazena contexto transitorio com TTL                                                |
| `get_working_memory`    | Le uma chave transitoria                                                             |
| `delete_working_memory` | Remove uma chave transitoria                                                         |
| `add_lesson`            | Registra conhecimento entre sessoes com decaimento de confianca                      |
| `list_lessons`          | Recupera licoes ativas acima de um limite de confianca                               |
| `forget_lesson`         | Remove uma licao permanentemente                                                     |
| `detect_patterns`       | Identifica comandos repetidos e erros recorrentes a partir de eventos de hook        |
| `compress_observations` | Comprime observacoes brutas de hooks em resumos tipados para reduzir o uso de tokens |

Os arquivos de estado ficam em `~/.egc/state/<project-slug>.md`. Um arquivo por projeto, Markdown simples, legivel por humanos.

---

## Biblioteca de prompts

**479 componentes**: opcional. Instale para ter acesso a 63 agentes, 229 skills e 76 comandos escritos com experiencia real. Ignore-os e o EGC ainda oferece memoria persistente.

| Componente | Total | Claude Code                                                  | Gemini CLI                                                   | Claude Code nativo |
| ---------- | ----- | ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------ |
| Agentes    | 63    | Compartilhado (AGENTS.md) | Compartilhado (AGENTS.md) | 12                 |
| Comandos   | 76    | Compartilhado                                                | Baseado em instrucoes                                        | 31                 |
| Skills     | 229   | Compartilhado                                                | 10 (formato nativo)                       | 37                 |
| Regras     | 111   | :                                            | :                                            | :  |

---

## Apoie o EGC

O EGC e desenvolvido por um unico desenvolvedor, mantido de forma aberta e gratuito.

- **[Entre no Discord](https://discord.gg/AtazrtxJ)**: faca perguntas, compartilhe feedback
- **[Patrocine no GitHub](https://github.com/sponsors/Fmarzochi)**: qualquer valor
- **[Doe pelo PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: sem necessidade de conta no GitHub
- **Marque o repositorio com estrela**: ajuda outros desenvolvedores a encontra-lo
- **[Contribua](../../.github/CONTRIBUTING.md)**: agentes, skills, comandos, correcoes de bugs, documentacao
- **Compartilhe**: se o EGC mudou sua forma de trabalhar, conte para alguem

### Patrocinadores

O apoio da comunidade mantem este projeto vivo e independente.

**Apoiadores**

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="48" height="48" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a> <a href="https://github.com/ayushikaul02"><img src="https://avatars.githubusercontent.com/u/212903502?v=4" width="48" height="48" alt="@ayushikaul02" title="@ayushikaul02" /></a>

**Patrocinadores mensais** · _seja o primeiro_

---

<div align="center">

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp; <a href="https://linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
