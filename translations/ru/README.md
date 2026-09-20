<!-- LANGUAGE-SELECTOR-START -->

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · **Русский** · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - Дайте Каждому ИИ-Агенту Один Общий Мозг

**Один локальный движок, который даёт каждому ИИ-инструменту для программирования на вашей машине одну и ту же память, одни и те же ограждения и один и тот же контекст, в каждой сессии.**

</div>

---

EGC: локальная среда выполнения для ИИ-инструментов программирования. Установите её один раз, и Cursor, Claude Code, Codex, Copilot, Aider и остальные из 20 поддерживаемых ИИ-инструментов будут делить одну зашифрованную память ваших проектов, один слой безопасности перед каждой командой, один фильтр, который не пускает шумный вывод к модели, и одну живую шину, через которую ваши открытые сессии видят друг друга. Нативно работает с Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere и Vertex AI, плюс OpenRouter для Qwen3, Llama 4 и других.

Ничего не покидает вашу машину. Память живёт в `~/.egc`, зашифрована AES-256-GCM, хранится отдельно для каждого проекта и ветки и никогда не коммитится в git.

---

## Установка

```bash
npm install -g @egchq/egc && egc install
```

Это весь движок. `egc install` находит ваши инструменты, регистрирует в каждом из них два локальных MCP-сервера, записывает протокол памяти, который читает каждый агент, и настраивает Token Crusher. Он задаёт один вопрос: нужна ли вам ещё и необязательная библиотека промптов, и по умолчанию ответ «нет».

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[Полное руководство по установке](../../docs/installation.md)

---

## Движок: Как Работает EGC

EGC: один мозг с четырьмя способностями. Каждая включена с первой установки, в каждом поддерживаемом инструменте, без единой команды, которую нужно выучить.

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### Память: Что Узнал Один Агент, Знают Все

Решения, контекст сессии, рабочая память и выученные уроки фиксируются по ходу работы и доступны в любом другом терминале, IDE или агенте, который вы откроете. Вы говорите естественно, на любом языке: «сохрани эту сессию», «что мы решили по авторизации?», «запомни это решение». EGC понимает намерение и сохраняет или вспоминает контекст. Запоминать команды не нужно.

### Сетка Сессий: Ваши Открытые Сессии Видят Друг Друга

Две вкладки Cursor, терминал Claude Code и сессия Antigravity делят одну живую шину. Они сообщают, над чем работают, занимают файлы, которые правят, передают работу друг другу и подхватывают события в момент их появления, поэтому параллельные сессии сотрудничают, а не сталкиваются.

### Guardian: Слой Безопасности Перед Каждой Командой

Guardian проверяет команды до выполнения, ставит заслон рискованным записям и не даёт контексту переполниться, в фоне, без единого вызова с вашей стороны. Покрытие зависит от поддержки хуков в каждом инструменте; исключение описано в [оценке безопасности](../../docs/security/SECURITY-ASSESSMENT.md#known-limitations).

### Token Crusher: Шум Никогда Не Доходит До Модели

Прежде чем вывод шелла дойдёт до модели, Token Crusher сжимает git-логи, шум тестов, спам установки и гигантские JSON до 90 процентов, сохраняя каждую ошибку и предупреждение. Спросите «сколько я сэкономил?» на любом языке, и ответ придёт прямо из вашего локального журнала.

---

## Быстрый Старт

Второго шага нет. Откройте любой из своих ИИ-инструментов и просто говорите: «привет», «продолжим», «запомни это решение», на любом языке. Сессии соединяются, память загружается, и каждая открытая вкладка уже знает, что делают остальные.

Живая панель с активностью агентов, токенами и расходами запускается сразу после установки. Предпочитаете ручное управление? Каждая команда описана в [руководстве по установке](../../docs/installation.md): скорее всего, вам ни одна не понадобится.

---

## Библиотека Промптов (Необязательно)

Отдельно от движка, и выключенная по умолчанию, EGC поставляет и библиотеку, написанную на основе реальных инженерных сессий: вы получаете доступ к 61 агенту, 232 навыкам и 77 командам, плюс 109 правил. Специалисты, которые сами ревьюят ваш код, руководства по лучшим практикам для каждого языка и ситуации, ярлыки, выполняющие целые последовательности задач, и правила стиля, которые держат код единообразным. Добавьте её во все найденные инструменты командой `egc install --prompt-library` или в один инструмент командой `egc install --target <tool> --profile full`. Пропустите её, и движок будет работать точно так же.

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · **Русский** · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

---

## Поддержи EGC

EGC создан одним разработчиком, поддерживается в открытом доступе и является бесплатным. Движок распространяется под Apache-2.0 и остаётся бесплатным: если EGC когда-нибудь предложит что-то платное, это будет командный слой поверх движка, но никогда не память на вашей машине.

- **[Сайт](https://fmarzochi.github.io/EGCSite)**: полная документация, обзор функций и демонстрация в реальном времени
- **[Видение](../../docs/VISION.md)**: куда движется EGC и что остаётся бесплатным
- **[Присоединяйтесь к Discord](https://discord.gg/TxppsGb52)**: задавайте вопросы, делитесь обратной связью
- **[Спонсор на GitHub](https://github.com/sponsors/Fmarzochi)**: любая сумма
- **[Пожертвовать через PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: аккаунт GitHub не требуется
- **Поставьте звёздочку репозиторию**: помогает другим разработчикам найти его
- **[Внесите свой вклад](../../.github/CONTRIBUTING.md)**: агенты, навыки, команды, исправления ошибок, документация
- **Поделитесь**: если EGC изменил ваш подход к работе, расскажите об этом кому-нибудь

### Спонсоры

Благодаря поддержке сообщества этот проект остаётся живым и независимым.

#### Партнёры по инструментам

ИИ-инструменты для программирования, нативно интегрированные с EGC. Партнёры получают размещение логотипа во всех README и на EGCSite.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### Спонсоры года · _Станьте первым спонсором года._

---

#### Бэкеры

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### Ежемесячные спонсоры · _станьте первым_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp; <a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
