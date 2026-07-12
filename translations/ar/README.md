<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · **العربية** · [Español](../es/README.md) · [हिन्दी](../hi/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC)

<div align="center">

# EGC - السياق العالمي الممتد (Extended Global Context)

**وكلاؤك الآليون لن يبدأوا من الصفر مرة أخرى أبدًا.**

*بلا إعداد. بلا أوامر. أنت تعمل، وEGC يتذكر.*

</div>

---

EGC هو وقت تشغيل محلي يمنح كل أداة برمجة تعتمد على الذكاء الاصطناعي تستخدمها ذاكرة مستمرة. في نهاية كل جلسة، يحفظ الذكاء الاصطناعي ما تعلمه عن مشروعك: القرارات التي اتخذتها، وما فشل، وتفضيلاتك، وما سيأتي بعد ذلك. في بداية الجلسة التالية، يقوم بتحميل تلك الحالة تلقائيًا دون أن تطلب ذلك. قل "لنكمل" أو "أين توقفنا؟" بأي لغة، وسيعرف الذكاء الاصطناعي بالفعل ما عليه فعله. تثبيت واحد يغطي Claude Code و Cursor و Gemini CLI و Windsurf و Zed و VS Code مع GitHub Copilot والمزيد.

---

## ذكاؤك الاصطناعي يعرف بالفعل

تفتح Claude Code في مشروع لم تلمسه منذ أسبوعين. دون كتابة أي شيء:

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

هذه ليست ذاكرة تخزين مؤقت لآخر محادثة. يتذكر EGC القرارات، والمحاولات الفاشلة، وتفضيلاتك، ويظل يقظًا طوال الجلسة، فيمنع الأوامر التي قد تدمر مشروعك قبل أن تُنفَّذ. لم تطلب أي شيء من هذا. لقد بدأت العمل فحسب.

<div align="center">
  <img src="../../assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## التثبيت

نفس أمر التثبيت على Windows وmacOS وLinux:

```bash
npm install -g @egchq/egc && egc install
```

لدى Windows بعض الملاحظات الخاصة به (إصدار PowerShell، Antigravity CLI، توقف الخطة المجانية لـ Gemini CLI): راجع [ملاحظات Windows](../../docs/installation.md#windows-notes) إن واجهت أي شيء غير متوقع.

أو التشغيل بدون تثبيت عالمي:

```bash
npx @egchq/egc install
```

**عقل واحد، أدوات متعددة.** بعد تثبيت امتداد GitHub Copilot Chat، يجد Copilot الـ skills بنفسه، وتظهر نفس الذاكرة الموجودة في Claude Code أو Cursor هناك أيضًا:

```bash
npm install -g @egchq/egc
egc install --target copilot
```

[دليل التثبيت الكامل](../../docs/installation.md)

---

## ما يقدمه EGC لذكائك الاصطناعي

يشغّل EGC دائمًا شيئين معًا في كل جلسة: ذاكرة تحفظ ما يهم، وطبقة أمان تمنع الأوامر الخطرة قبل تنفيذها. كل ذلك جاهز دون أي إعداد.

### الذاكرة: ما يتذكره ذكاؤك الاصطناعي بنفسه

لن تحفظ أي أمر عن ظهر قلب أبدًا. قلها بأي لغة: "أكمل من الأمس"، "تذكر هذا القرار"، "ما الذي تعطّل آخر مرة؟"، وسيعرف ذكاؤك الاصطناعي بالضبط ما عليه فعله. العمل لك، والتذكر لـ EGC.

**`egc-memory`**

| الأداة | ماذا تفعل |
|---|---|
| `get_state` | يحمّل كل ما كان يعرفه ذكاؤك الاصطناعي عن المشروع لحظة فتح الجلسة |
| `update_state` | يحفظ ما تقرر اليوم حتى لا يفقد أحد الخيط غدًا |
| `store_decision` | يسجّل قرارًا مهمًا واحدًا، بشكل دائم |
| `query_history` | يعرض القرارات السابقة بترتيب حدوثها |
| `search_history` | يجد أي شيء تقرر يومًا ما، حتى لو لم تتذكر التاريخ |
| `working_memory_set` / `_get` / `_list` | ملاحظات سريعة تنتهي صلاحيتها تلقائيًا عندما لا تعود مفيدة |
| `lesson_save` | يسجل درسًا مستفادًا، تضعف قوته مع الوقت إن لم يتأكد منه أحد مجددًا |
| `lesson_recall` | يستعيد الدروس التي لا تزال تستحق العمل بها |
| `lesson_reinforce` | يعزز درسًا عند تأكيده مرة أخرى |
| `detect_patterns` | يلاحظ عندما يتكرر نفس الخطأ أو الأمر كثيرًا |
| `compress_observations` | يلخّص السجل الخام حتى لا تهدر الرموز (tokens) عبثًا |
| `get_project_state` | يتأكد أن الذاكرة تعمل كما ينبغي |

كل فرع (branch) في مشروعك يحتفظ بذاكرته الخاصة، مشفّرة على جهازك: لا يستطيع أحد آخر الوصول إليها، ولا حتى السحابة. خصوصية افتراضية، دون إعداد أي شيء.

### السياق والأمان: ما يحرس عملك

**`egc-guardian`**

هذه الأدوات تعمل تلقائياً في الخلفية. كل أمر shell وكل كتابة ملف يتم فحصهما قبل التنفيذ. لا تحتاج إلى استدعائها مباشرة.

| الأداة | ماذا تفعل |
|---|---|
| `validate_command` | يفحص كل أمر قبل تنفيذه: يمنع ما قد يسبب ضررًا |
| `validate_write` | يمنع ذكاءك الاصطناعي من الكتابة في ملفات حساسة عن طريق الخطأ |
| `reduce_context` | يضغط الملفات الكبيرة حتى لا تهدر ميزانية الرموز عبثًا |
| `orchestrate_task` | يختار الأدوات الصحيحة لكل طلب، دون أن تحتاج لمعرفة أيها موجود |
| `auto_learn` | يتعلم من أخطاء الجلسة ويسجلها حتى لا تتكرر |

### مُطبَّق بالكود، لا بالطلب

أمان لا يعتمد على مزاج الذكاء الاصطناعي: كل أمر يمر عبر EGC قبل تنفيذه، دائمًا. [تفاصيل كاملة عن تطبيق الـ harness، وكشف نية الجلسة، ومنقّب الذاكرة →](../../docs/installation.md#enforcement)

### ذاكرة واحدة. لكل أدواتك.

شغّل **`egc watch`** مرة واحدة وانسَه. غيّر السياق في Cursor، ويظهر تلقائيًا في Gemini CLI و Copilot و Windsurf و Zed: في كل ما تستخدمه. بلا خطوات يدوية، وبلا حالة قديمة في أي مكان.

```
egc watch              # مراقبة المشروع الحالي
egc watch /path/proj   # مراقبة مشروع محدد
egc watch --quiet      # كتم المخرجات
```

### لوحة التحكم: شاهد وكلاءك وهم يعملون

شاهد كل استدعاء أداة وكل رمز وتكلفة يولّدها وكلاؤك، مباشرةً في المتصفح. تبدأ تلقائياً بعد `egc init`. [الدليل الكامل](../../docs/installation.md#dashboard)

---

## مكتبة الأوامر

كمكافأة، يمنحك EGC أيضًا وصولًا إلى 63 agent و230 skill و77 command، بالإضافة إلى 111 rule: خبراء يراجعون كودك بأنفسهم، وأدلة أفضل الممارسات لكل لغة وموقف، واختصارات تنفذ سلسلة كاملة من المهام نيابة عنك، وقواعد أسلوب تحافظ على اتساق الكود. كلها مكتوبة من جلسات هندسة حقيقية، لا نظريات. لا تريد استخدام أي منها؟ لا بأس: تعمل ذاكرة EGC المستمرة بنفس الطريقة تمامًا.

---

🌐 [English](../../README.md) · **العربية** · [Español](../es/README.md) · [हिन्दी](../hi/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md)

---

## دعم EGC

تم بناء EGC بواسطة مطور واحد، ويتم صيانته بشكل علني ومجاني.

- **[انضم إلى Discord](https://discord.gg/AtazrtxJ)**: اطرح الأسئلة وشارك التعليقات
- **[رعاية المشروع على GitHub](https://github.com/sponsors/Fmarzochi)**: أي مبلغ يساعد
- **[تبرع عبر PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: لا يلزم وجود حساب GitHub
- **ضع نجمة على المستودع**: يساعد المطورين الآخرين في العثور عليه
- **[المساهمة](../../.github/CONTRIBUTING.md)**: وكلاء، مهارات، أوامر، إصلاح أخطاء، وثائق
- **المشاركة**: إذا غير EGC طريقة عملك، أخبر أحداً بذلك

### الرعاة

دعم المجتمع يبقي هذا المشروع حياً ومستقلاً.

#### شركاء الأدوات

أدوات البرمجة بالذكاء الاصطناعي التي تتكامل بشكل أصلي مع EGC. يحصل الشركاء على مساحة للشعار في جميع ملفات README وموقع EGCSite.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### الرعاة السنويون · _كن أول راعٍ سنوي._

---

#### الداعمون

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a> <a href="https://github.com/muhammadhasnain3031"><img src="https://avatars.githubusercontent.com/u/262106526?v=4" width="48" height="48" alt="@muhammadhasnain3031" title="@muhammadhasnain3031, Arabic translation" /></a>

#### الرعاة الشهريون · _كن الأول_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
