<!-- LANGUAGE-SELECTOR-START -->
**Язык:** [English](../../README.md) | [العربية](../ar/README.md) | [Español](../es/README.md) | [हिन्दी](../hi/README.md) | [한국어](../ko/README.md) |
[Português (Brasil)](../pt/README.md) | **Русский**
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![npm version](https://img.shields.io/npm/v/@egchq/egc?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@egchq/egc) [![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Discord](https://img.shields.io/discord/1513941515452416130?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/AtazrtxJ) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](.github/CONTRIBUTING.md) [![Stars](https://img.shields.io/github/stars/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/stargazers) [![Forks](https://img.shields.io/github/forks/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/network/members) [![Issues](https://img.shields.io/github/issues/Fmarzochi/EGC)](https://github.com/Fmarzochi/EGC/issues) [![Maintained](https://img.shields.io/badge/Maintained-yes-brightgreen)](https://github.com/Fmarzochi/EGC/commits/main) [![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC) [![Featured on Product Hunt](https://img.shields.io/badge/Product%20Hunt-featured-DA552F?logo=producthunt&logoColor=white)](https://www.producthunt.com/posts/egc)

<!-- CENTERED-LANGUAGE-SELECTOR-START -->
<div align="center">

**Language / اللغة / Idioma / भाषा / 언어**

[English](../../README.md) | [العربية](../ar/README.md) | [Español](../es/README.md) | [हिन्दी](../hi/README.md) | [한국어](../ko/README.md) | [Português (Brasil)](../pt/README.md) | **Русский**

</div>
<!-- CENTERED-LANGUAGE-SELECTOR-END -->

<div align="center">

# EGC - Расширенный глобальный контекст (Extended Global Context)

**Ваши ИИ-агенты больше никогда не начнут с нуля.**

*Не нужно запоминать никаких команд. Просто работайте — EGC позаботится обо всем остальном.*

</div>

---

EGC — это локальная среда выполнения, которая обеспечивает постоянную память для каждого используемого вами инструмента программирования ИИ. В конце каждой сессии ваш ИИ сохраняет полученные знания: принятые решения, ошибки, ваши предпочтения, что нужно продолжить. В начале следующей сессии он автоматически загружает это состояние — без каких-либо подсказок. Скажите «продолжим» или «на каком этапе мы остановились?» на любом языке, и ваш ИИ уже будет знать, что делать. Одна установка охватывает Claude Code, Cursor, Gemini CLI, Windsurf и другие. Работает с моделями Claude, GPT-4o, Gemini и OpenRouter, включая DeepSeek, Qwen3 и Llama 4.

---

## Вот как выглядит EGC на практике.

Вы открываете Claude Code на проекте, к которому не прикасались две недели. Ничего не вводя:

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

ИИ уже знает, что вы создавали, какие решения принимали, что пошло не так и где именно остановились. Он знает это, потому что EGC сохранил это состояние в конце вашей последней сессии и загрузил его обратно при начале этой — самостоятельно, без вашего запроса. Вы ничего не вводили. Вы просто начали работать.

<div align="center">
  <img src="../../assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## Установка

```bash
npm install -g @egchq/egc && egc install
```

Или запустите без глобальной установки:

```bash
npx @egchq/egc install
```

[Полное руководство по установке](../../docs/installation.md)

---

## Что EGC дает вашему ИИ

EGC поставляет два сервера MCP, которые работают вместе в течение каждой сессии.

### Память — 14 инструментов, которые ваш ИИ использует автоматически.

Не нужно запоминать команды. Ваш ИИ читает эту таблицу, поэтому вам никогда не придется этого делать. Скажите что угодно на любом языке — «продолжи с вчерашнего дня», «вспомни это решение», «что сломалось в прошлый раз?» — и он вызовет нужный инструмент. Вам остается только работать. EGC позаботится обо всем остальном.

**`egc-memory`**

| Tool | What it does |
|---|---|
| `get_state` | Загружает память проекта при начале сессии |
| `update_state` | Сохраняет решения, предпочтения и дальнейшие шаги |
| `store_decision` | Сохраняет единое решение в SQLite |
| `query_history` | Возвращает прошлые решения по временной метке |
| `search_history` | Полнотекстовый поиск с использованием рейтинга BM25 |
| `working_memory_set` | Сохраняет временный контекст с TTL |
| `working_memory_get` | Считывает временный ключ |
| `working_memory_list` | Выводит список всех активных временных записей для текущего проекта |
| `lesson_save` | Записывает межсессионные знания с учетом угасания их веса |
| `lesson_recall` | Извлекает активные выводы, прошедшие порог уверенности |
| `lesson_reinforce` | Повышает уровень уверенности в выводе при повторении того же паттерна |
| `detect_patterns` | Выявляет повторяющиеся команды и повторяющиеся ошибки, возникающие в результате событий перехвата |
| `compress_observations` | Сжимает исходные данные хуков в типизированные сводки для уменьшения использования токенов |
| `get_project_state` | Возвращает метаданные о состоянии сервера и статус механизма хранения данных |

Файлы состояния находятся по пути `~/.egc/state/<project-slug>.md`. Один файл на проект, обычный Markdown, читаемый человеком формат.

### Контекст и безопасность — 5 инструментов на случай критических ситуаций

**`egc-guardian`**

Эти инструменты работают автоматически в фоновом режиме. Каждая консольная команда и каждая запись в файл проверяются перед выполнением. Вам никогда не придётся вызывать их напрямую.

| Инструмент | Что он делает |
|---|---|
| `validate_command` | Перед выполнением проверяет консольные команды  на соответствие правилам безопасности проекта |
| `validate_write` | Проверяет пути записи в файлы для предотвращения небезопасной записи |
| `reduce_context` | Сжимает содержимое файлов для экономии вашего бюджета токенов |
| `orchestrate_task` | Маршрутизирует промпты с учетом контекста агента/навыка и возвращает метрики сжатия |
| `auto_learn` | Анализирует сбои сессий и записывает готовые к применению выводы во все конфигурационные файлы ИИ-инструментов в проекте |

### Всегда синхронизировано — во всех используемых вами инструментах.

**`egc watch`** - запустите один раз, и все используемые вами инструменты будут синхронизированы.  Редактируйте контекст в Cursor, и он автоматически появится в Gemini CLI, Copilot, Windsurf и везде где угодно. При обновлении вашего состояния все конфигурационные файлы инструментов обновляются вместе с ним. Никаких ручных действий, никакого устаревшего контекста.

```
egc watch              # отслеживать текущий проект
egc watch /path/proj   # отслеживать конкретный проект по указанному пути
egc watch --quiet      # скрыть вывод в терминале
```

### Дашборд — оперативный центр управления

Отслеживайте каждый вызов инструментов, расход токенов и затраты, которые генерируют ваши агенты, в реальном времени прямо в браузере. Запускается автоматически после выполнения `egc init`. [Полный гайд](../../docs/installation.md#dashboard)

---

## Библиотека промптов

**479 компонентов** включено в качестве бонуса. Установите, чтобы получить доступ к 63 агентам, 229 навыкам и 76 командам, а также 111 правилам, написанным на основе реальных инженерных сессий. Пропустите их полностью, и EGC все равно обеспечит вам постоянную память.

---

## Поддержи EGC

EGC создан одним разработчиком, поддерживается в открытом доступе и является бесплатным.

- **[Сайт](https://fmarzochi.github.io/EGCSite)**: полная документация, обзор функций и демонстрация в реальном времени.
- **[Присоединяйтесь к Discord](https://discord.gg/AtazrtxJ)**: задавайте вопросы, делитесь обратной связью
- **[Спонсор на GitHub](https://github.com/sponsors/Fmarzochi)**: любая сумма
- **[Пожертвовать через PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: аккаунт GitHub не требуется
- **Поставьте звездочку репозиторию**: помогает другим разработчикам найти его
- **[Внесите свой вклад](../../.github/CONTRIBUTING.md)**: агенты, навыки, команды, исправления ошибок, документация
- **Поделитесь**: если EGC изменил ваш подход к работе, расскажите об этом кому-нибудь

### Спонсоры

Благодаря поддержке сообщества этот проект остается живым и независимым.

#### Партнеры по инструментам

Инструменты для программирования с использованием ИИ, интегрированные с EGC. Партнеры получают возможность разместить свой логотип во всех файлах README и на сайте EGCSite.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### Спонсоры года · _Станьте первым спонсором года._

---

#### Сторонники

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### Ежемесячные спонсоры · _станьте первым_

---

<div align="center">

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
