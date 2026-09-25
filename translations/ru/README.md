<!-- LANGUAGE-SELECTOR-START -->

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · **Русский** · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - Дайте Каждому ИИ-Агенту Один Общий Мозг

**Один локальный движок, который предоставляет каждому инструменту для кодирования AI на вашей машине одинаковую память, одинаковые гаранты и одинаковый контекст на каждой сессии.**

</div>

---

EGC: локальная среда выполнения для ИИ-инструментов программирования. Установите его один раз и Cursor, Claude Code, Copilot, Aider и остальные 20 инструментов ИИ кодирования он поддерживает совместное использование одной зашифрованной памяти ваших проектов, один слой безопасности перед каждой командой, один фильтр, который держит шумовую отдачу от модели, и один живой автобус, который позволяет вашим открытым сессиям видеть друг друга. Нативно работает с Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere и Vertex AI, плюс OpenRouter для Qwen3, Llama 4 и других.

Ничего не оставляет на вашей машине. Вся память живёт в `~/.egc` на вашей машине, зашифрована AES-256-GCM, хранится отдельно для каждой ветки проекта и никогда не коммитится в репозиторий.

---

## Установка

```bash
npm install -g @egchq/egc && egc install
```

Это весь двигатель. `egc install` обнаруживает инструменты, которые вы имеете, регистрирует два локальных MCP сервера в каждом из них, Запись протокола памяти каждого агента и настройка Token Crusher. Он задает один вопрос, хотите ли вы также создать необязательную библиотеку подсказок, а по умолчанию - нет.

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[Полное руководство по установке](../../docs/installation.md)

---

## Внутри Мозга: Как Работает EGC

ЕГК - это один мозг с четырьмя факультетами. Каждый из них находится в первой инсталляции, в каждой поддерживаемой утилите, без каких-либо команд.

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### Память: что за один учебный заработок агента, каждый знающий агента

Он фиксирует решения, контекст сессии, рабочую память и выученные паттерны, и мгновенно делает их доступными в любом другом терминале, IDE или агенте. Говорите с мозгом на любом языке: «сохрани эту сессию», «что мы решили по авторизации?», «запомни это решение». EGC понимает намерение и хранит или ссылается на контекст. Нет команды для запоминания.

### Сеанс сессии: Ваши открытые сессии просматривают каждый другой

Две вкладки курсора, терминал кода Claude и сеанс Антигравитации имеют одну живую шину. Они сообщают о том, что они работают, претендуют на редактируемые файлы, работать друг с другом и поднимать события в тот момент, когда они увязываются, так что параллельные сессии сотрудничают вместо столкновения.

### Guardian: Встроенные Ограждения Безопасности

Защитник проверяет команды до их запуска, ворот рискованно записывает контекст из переполнения, в фоновом режиме, без вызова ничего. Покрытие зависит от поддержки каждого инструмента по хуку; исключение документов: [Оценка безопасности](../../docs/security/SECURITY-ASSESSMENT.md#known-limitations).

### Token Crusher: шум никогда не доходит до модели

Прежде чем вывод шелла дойдёт до модели, Token Crusher сжимает git-логи, шум тестов, спам установки и гигантские JSON до 90%, сохраняя каждую ошибку и предупреждение. Просто спросите «сколько я сэкономил?»

---

## Быстрый Старт

Второго шага нет. Откройте любой из своих ИИ-инструментов и просто говорите: «привет», «продолжим», «запомни это решение», на любом языке. Сессия регистрируется сама, память загружается сама, и каждая открытая вкладка уже знает, что делают остальные: две вкладки Cursor, терминал Claude Code и сессия Antigravity делят один живой контекст, одновременно.

Живая панель с активностью, токенами и расходами ваших агентов запускается сама сразу после установки. Предпочитать явное управление? Все команды описаны в [руководстве по установке](../../docs/installation.md): скорее всего, вам ни одна не понадобится.

---

## Библиотека Промптов

Отдельно от двигателя и выключен, по умолчанию EGC также поставляет библиотеку, написанную с реальных инженерных сессий: вы получаете доступ к 61 агентам, 232 навыка и 77 команд, плюс 109 правил. В качестве бонуса EGC даёт доступ к 61 агенту, 230 скиллам и 77 командам, плюс 109 правил: специалисты, которые сами ревьюят ваш код, руководства по лучшим практикам для каждого языка и ситуации, ярлыки, выполняющие целые последовательности задач, и правила стиля, которые держат код единообразным. Добавьте его к каждому обнаруженному инструменту с помощью `egc install --prompt-library`, или к одному инструменту с `egc install --target <tool> --profile full`. Пропустите его, и двигатель работает точно так же.

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · **Русский** · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

---

## Поддержи EGC

EGC создан одним разработчиком, поддерживается в открытом доступе и является бесплатным. Движок Apache-2. и пребывание бесплатно: если EGC когда-либо предлагает что-то платное, он будет слоем команды поверх него, никогда не памяти на вашей машине.

- **[Сайт](https://fmarzochi.github.io/EGCSite)**: полная документация, обзор функций и демонстрация в реальном времени
- **[Vision](../../docs/VISION.md)**: где идет EGC, и что остается бесплатным
- **[Присоединяйтесь к Discord](https://discord.gg/FmXbgUmdmM)**: задавайте вопросы, делитесь обратной связью
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

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a> <a href="https://github.com/Vile93"><img src="https://avatars.githubusercontent.com/u/107775351?v=4" width="52" height="52" alt="@Vile93" title="@Vile93" /></a>

#### Ежемесячные спонсоры · _станьте первым_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp; <a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
