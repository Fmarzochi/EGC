<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Español](../es/README.md) · [हिन्दी](../hi/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · **Русский**
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC)

<div align="center">

# EGC - Расширенный глобальный контекст (Extended Global Context)

**Ваши ИИ-агенты больше никогда не начнут с нуля.**

*Никакой настройки. Никаких команд. Вы работаете, EGC запоминает.*

</div>

---

EGC представляет собой локальную среду выполнения, которая обеспечивает постоянную память для каждого используемого вами инструмента программирования ИИ. В конце каждой сессии ваш ИИ сохраняет полученные знания: принятые решения, ошибки, ваши предпочтения, что нужно продолжить. В начале следующей сессии он автоматически загружает это состояние, без каких-либо подсказок с вашей стороны. Скажите "продолжим" или "на каком этапе мы остановились?" на любом языке, и ваш ИИ уже будет знать, что делать. Одна установка охватывает Claude Code, Cursor, Gemini CLI, Windsurf, Zed, Warp, VS Code с GitHub Copilot и другие (всего 19 инструментов). Нативно работает с Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere и Vertex AI, а также с OpenRouter для Qwen3, Llama 4 и других.

---

## Ваш ИИ уже знает

Вы открываете Claude Code на проекте, к которому не прикасались две недели. Ничего не вводя:

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

Это не кэш вашего последнего разговора. EGC помнит решения, тупики и ваши предпочтения, а также стоит на страже всю сессию, блокируя команды, которые могли бы разрушить вашу кодовую базу, ещё до их выполнения. Вы ничего не просили. Вы просто начали работать.

<div align="center">
  <img src="../../assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## Установка

Одна и та же команда установки на Windows, macOS и Linux:

```bash
npm install -g @egchq/egc && egc install
```

У Windows есть несколько своих особенностей (версия PowerShell, Antigravity CLI, прекращённый бесплатный тариф Gemini CLI): если что-то пойдёт не так, загляните в [заметки для Windows](../../docs/installation.md#windows-notes).

Или запустите без глобальной установки:

```bash
npx @egchq/egc install
```

**Один мозг, много инструментов.** С установленным расширением GitHub Copilot Chat Copilot сам находит навыки, и та же память, что уже есть в Claude Code или Cursor, появляется и там:

```bash
npm install -g @egchq/egc
egc install --target copilot
```

[Полное руководство по установке](../../docs/installation.md)

---

## Что EGC даёт вашему ИИ

EGC всегда запускает две вещи вместе, в каждой сессии: память, которая хранит важное, и уровень безопасности, который блокирует опасные команды до их выполнения. Всё готово сразу, без настройки.

### Память: что ваш ИИ помнит сам

Вам никогда не придётся запоминать команды. Скажите на любом языке: "продолжи с вчерашнего дня", "запомни это решение", "что сломалось в прошлый раз", и ваш ИИ точно знает, что делать. Работа ваша, а память доверьте EGC.

**`egc-memory`**

| Инструмент | Что он делает |
|---|---|
| `get_state` | Загружает всё, что ваш ИИ уже знал о проекте, в момент открытия сессии |
| `update_state` | Сохраняет то, что решено сегодня, чтобы завтра никто не потерял нить |
| `store_decision` | Навсегда фиксирует одно важное решение |
| `query_history` | Показывает прошлые решения в порядке их появления |
| `search_history` | Находит любое решение, даже если вы не помните дату |
| `working_memory_set` / `_get` / `_list` | Быстрые заметки, которые сами исчезают, когда становятся не нужны |
| `lesson_save` | Записывает извлечённый урок, вес которого со временем угасает, если его не подтвердить снова |
| `lesson_recall` | Возвращает уроки, которые всё ещё актуальны |
| `lesson_reinforce` | Усиливает урок, когда он подтверждается снова |
| `detect_patterns` | Замечает, когда одна и та же ошибка или команда повторяется слишком часто |
| `compress_observations` | Сжимает необработанную историю в сводку, чтобы не тратить токены впустую |
| `get_project_state` | Проверяет, что память работает как должна |

Каждая ветка (branch) вашего проекта хранит собственную память, зашифрованную на вашем компьютере: никто другой не имеет к ней доступа, даже облако. Приватность по умолчанию, ничего настраивать не нужно.

### Контекст и безопасность: что стоит на страже во время работы

**`egc-guardian`**

Эти инструменты работают автоматически в фоновом режиме. Каждая консольная команда и каждая запись в файл проверяются перед выполнением. Вам никогда не придётся вызывать их напрямую.

| Инструмент | Что он делает |
|---|---|
| `validate_command` | Проверяет каждую команду перед выполнением: блокирует те, что могут навредить |
| `validate_write` | Не даёт ИИ случайно записать что-то в чувствительные файлы |
| `reduce_context` | Сжимает большие файлы, чтобы не тратить впустую бюджет токенов |
| `orchestrate_task` | Подбирает нужные инструменты под каждый запрос, не требуя от вас знать, какие вообще существуют |
| `auto_learn` | Учится на ошибках сессии и записывает их, чтобы они не повторялись |

### Обеспечивается кодом, а не просьбой

Безопасность, которая не зависит от настроения ИИ: каждая команда всегда проходит через EGC перед выполнением. [Подробности о работе harness, определении намерения сессии и о майнере памяти →](../../docs/installation.md#enforcement)

### Одна память. Все ваши инструменты.

Запустите **`egc watch`** один раз и забудьте о нём. Измените контекст в Cursor, и он сам появится в Gemini CLI, Copilot, Windsurf, Zed: везде, где вы работаете. Никаких ручных шагов, никакого устаревшего состояния нигде.

```
egc watch              # отслеживать текущий проект
egc watch /path/proj   # отслеживать конкретный проект по указанному пути
egc watch --quiet      # скрыть вывод в терминале
```

### Дашборд: смотрите, как работают ваши агенты

Отслеживайте каждый вызов инструментов, расход токенов и затраты, которые генерируют ваши агенты, в реальном времени прямо в браузере. Запускается автоматически после выполнения `egc init`. [Полное руководство](../../docs/installation.md#dashboard)

---

## Библиотека промптов

В качестве бонуса EGC также даёт доступ к 63 agent, 230 skill и 77 command, плюс 111 rule: специалисты, которые сами проверяют ваш код, руководства по лучшим практикам для любого языка и ситуации, ярлыки, запускающие целую последовательность задач за вас, и стилевые правила, поддерживающие единообразие кода. Всё написано на основе реальных инженерных сессий, а не теории. Не хотите ничего из этого использовать? Не страшно: постоянная память EGC работает точно так же.

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Español](../es/README.md) · [हिन्दी](../hi/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · **Русский**

---

## Поддержи EGC

EGC создан одним разработчиком, поддерживается в открытом доступе и является бесплатным.

- **[Сайт](https://fmarzochi.github.io/EGCSite)**: полная документация, обзор функций и демонстрация в реальном времени
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
<a href="https://github.com/Vile93"><img src="https://avatars.githubusercontent.com/u/107775351?v=4" width="52" height="52" alt="@Vile93" title="@Vile93" /></a>

#### Ежемесячные спонсоры · _станьте первым_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
