<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Español](../es/README.md) · [हिन्दी](../hi/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · **Português (Brasil)** · [Русский](../ru/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC)

<div align="center">

# EGC - Extended Global Context

**Seus agentes de IA nunca mais começarão do zero.**

*Configuração zero. Comandos zero. Você trabalha, o EGC lembra.*

</div>

---

EGC é um runtime local que oferece memória persistente para cada ferramenta de IA que você usa. Ao final de cada sessão, a IA salva o que aprendeu sobre o seu projeto: as decisões tomadas, o que falhou, suas preferências e os próximos passos. No início da próxima sessão, ela carrega esse estado de volta sozinha, sem você pedir nada. Diga "vamos continuar" ou "onde paramos?" em qualquer idioma e sua IA já sabe o que fazer. Uma única instalação cobre Claude Code, Cursor, Gemini CLI, Windsurf, Zed, VS Code com GitHub Copilot e muito mais. Compatível com Claude, GPT-4o, Gemini e modelos OpenRouter, incluindo DeepSeek, Qwen3 e Llama 4.

---

## Sua IA já sabe

Você abre o Claude Code em um projeto que não toca há duas semanas. Sem digitar nada:

```
State loaded from egc-memory via ~/.egc/state/MyApp/main.md

Context and preferences acknowledged.

Ready to pick up:
• Fix the rate limiter edge case on concurrent requests
• Add integration tests for the new auth module
• Review open PR from @contributor before merging

=== EGC Stack Briefing ===
Stack: typescript, node
Skills: tdd-workflow, coding-standards
Agents: code-reviewer
Guardian: active, every command checked before it runs
===
```

Isso não é um cache da sua última conversa. O EGC lembra das decisões, dos becos sem saída e das suas preferências, e fica de guarda a sessão inteira, bloqueando os comandos que incendiariam seu código antes deles rodarem. Você não pediu nada disso. Só começou a trabalhar.

<div align="center">
  <img src="../../assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## Instalação

🪟 Windows &nbsp;&middot;&nbsp; 🍎 macOS &nbsp;&middot;&nbsp; 🐧 Linux, o mesmo comando em qualquer sistema:

```bash
npm install -g @egchq/egc && egc install
```

Ou execute sem instalar globalmente:

```bash
npx @egchq/egc install
```

**Um cérebro, várias ferramentas.** Com a extensão do GitHub Copilot Chat instalada, o Copilot encontra as skills sozinho, e a mesma memória que você já tem no Claude Code ou no Cursor aparece lá também:

```bash
npm install -g @egchq/egc
egc install --target copilot
```

[Guia de instalação completo](../../docs/installation.md)

---

## O que o EGC oferece à sua IA

O EGC sempre roda duas coisas juntas, em toda sessão: uma memória que guarda o que importa, e uma camada de segurança que barra comando perigoso antes dele rodar. Vem tudo pronto, sem configurar nada.

### Memória: o que sua IA lembra sozinha

Você nunca vai memorizar comando nenhum. Fala em qualquer língua: "continua de ontem", "lembra dessa decisão", "o que quebrou da última vez", e sua IA sabe exatamente o que fazer. O trabalho é seu, a lembrança é do EGC.

**`egc-memory`**

| Ferramenta | O que faz |
|---|---|
| `get_state` | Carrega tudo que sua IA já sabia sobre o projeto assim que a sessão abre |
| `update_state` | Guarda o que foi decidido hoje pra amanhã ninguém perder o fio |
| `store_decision` | Anota uma decisão importante pra sempre |
| `query_history` | Mostra decisões antigas, em ordem de quando aconteceram |
| `search_history` | Busca qualquer coisa que já foi decidida, mesmo sem lembrar a data |
| `working_memory_set` / `_get` / `_list` | Anotações rápidas que expiram sozinhas quando não servem mais |
| `lesson_save` | Grava um aprendizado, que perde força com o tempo se ninguém confirmar de novo |
| `lesson_recall` | Traz de volta os aprendizados que ainda valem a pena |
| `lesson_reinforce` | Reforça um aprendizado quando ele se confirma de novo |
| `detect_patterns` | Percebe quando o mesmo erro ou comando se repete demais |
| `compress_observations` | Resume o histórico bruto pra não gastar tokens à toa |
| `get_project_state` | Confere se a memória está funcionando direito |

Cada branch do seu projeto guarda sua própria memória, criptografada no seu computador: ninguém mais tem acesso, nem a nuvem. Privacidade de fábrica, sem configurar nada.

### Contexto e segurança: o que fica de guarda enquanto você trabalha

**`egc-guardian`**

Essas ferramentas rodam sozinhas, em segundo plano. Todo comando de shell e toda escrita de arquivo é conferida antes de executar. Você nunca as chama diretamente.

| Ferramenta | O que faz |
|---|---|
| `validate_command` | Confere todo comando antes de rodar: bloqueia o que pode dar problema |
| `validate_write` | Impede que a IA escreva em arquivos sensíveis por engano |
| `reduce_context` | Enxuga arquivos grandes pra não gastar seu orçamento de tokens à toa |
| `orchestrate_task` | Escolhe as ferramentas certas pra cada pedido, sem você precisar saber quais existem |
| `auto_learn` | Aprende com os erros da sessão e já deixa anotado pra não repetir |

### Imposto por código, não por pedido

Segurança que não depende da IA estar de bom humor: todo comando passa pelo EGC antes de rodar, sempre. [Detalhes completos sobre a aplicação via harness, detecção de intenção e o minerador de memória →](../../docs/installation.md#enforcement)

### Uma memória. Todas as suas ferramentas.

Roda **`egc watch`** uma vez, esquece que existe. Muda contexto no Cursor, aparece sozinho no Gemini CLI, Copilot, Windsurf, Zed: em tudo que você usa. Sem passo manual, sem versão desatualizada em lugar nenhum.

```
egc watch              # monitorar projeto atual
egc watch /caminho     # monitorar projeto específico
egc watch --quiet      # suprimir saída
```

### Dashboard: veja seus agentes trabalhando

Veja cada comando, token e custo gerado pelos seus agentes, direto no navegador. Inicia automaticamente após `egc init`. [Guia completo](../../docs/installation.md#dashboard)

---

## Biblioteca de prompts

De bônus, o EGC também dá acesso a 63 agents, 230 skills e 77 commands, mais 111 rules: especialistas que revisam seu código sozinhos, guias de boas práticas pra cada linguagem e situação, atalhos que executam uma sequência inteira de tarefas, e regras de estilo que mantêm o código consistente. Tudo escrito a partir de sessões reais de engenharia, não teoria. Não quer usar nada disso? Tudo bem: a memória persistente do EGC funciona do mesmo jeito.

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Español](../es/README.md) · [हिन्दी](../hi/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · **Português (Brasil)** · [Русский](../ru/README.md)

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

Ferramentas de programação com IA que se integram nativamente com o EGC. Os parceiros recebem espaço para logo em todos os READMEs e no EGCSite.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### Patrocinadores anuais · _Seja o primeiro patrocinador anual._

---

#### Apoiadores

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### Patrocinadores mensais · _seja o primeiro_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
