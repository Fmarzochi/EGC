<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · **العربية** · [Español](../es/README.md) · [हिन्दी](../hi/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [简体中文](../zh-CN/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![npm downloads](https://img.shields.io/npm/dm/@egchq/egc?label=downloads&color=22c55e)](https://www.npmjs.com/package/@egchq/egc) [![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc)

<div align="center">

# EGC - امنح كل وكيل ذكاء اصطناعي الدماغ نفسه

**ذاكرة دائمة يتشاركها تلقائيًا كل وكيل ذكاء اصطناعي وكل IDE وكل طرفية وكل جلسة. لا أوامر تحفظها. لا سياق تعيد بناءه. تحدّث فحسب.**

</div>

---

EGC ليس أداة ذاكرة أخرى. إنه طبقة الذكاء التي تجعل أي ذكاء اصطناعي يعمل كأنه في مشروعك منذ اليوم الأول، في Cursor وCopilot وClaude Code وCodex وAider وأي وكيل طرفية (20 أداة برمجة بالذكاء الاصطناعي إجمالًا). يعمل أصلاً مع Claude وGPT-4o وGemini وDeepSeek وMistral وGroq وCohere وVertex AI، إضافة إلى OpenRouter لـ Qwen3 وLlama 4 والمزيد.

كل محادثة تبني الذكاء الجماعي لمشروعك. كل وكيل يرثه. وكل جلسة تصبح أذكى.

---

## التثبيت

```bash
npm install -g @egchq/egc && egc install
```

- **قلّل هدر السياق حتى 90%، واخفض تكاليف التوكنز، وأبقِ كل الذكاءات الاصطناعية متناسقة تمامًا عبر الجلسات.**
- **Guardian: يتحقق من كل أمر قبل تنفيذه، ويحجب الكتابات الخطرة، ويكشف حقن الأوامر. كل دماغ مشترك يأتي بطبقة أمان مدمجة.**
- **أمر واحد، بلا إعدادات: تبقى الذاكرة محلية ومشفّرة على جهازك، ولا تُرفع أبدًا إلى git.**

<div align="center">
  <img src="../../assets/install.gif" alt="EGC install" width="800" />
</div>

[دليل التثبيت الكامل](../../docs/installation.md)

---

## داخل الدماغ: كيف يعمل EGC

EGC ليس قائمة أدوات؛ إنه دماغ واحد بعدة ملكات. يتذكر ويفهم ويحمي ويصفّي وينسّق، عبر كل وكلاء الذكاء الاصطناعي على جهازك.

<div align="center">
  <img src="../../assets/sharedbrain.gif" alt="Cursor to Claude Code shared memory" width="900" />
</div>

### لا تحفظ الأوامر، تحدّث بشكل طبيعي

خاطب الدماغ بأي لغة: «احفظ هذه الجلسة»، «ماذا قررنا بشأن المصادقة؟»، «تذكّر هذا القرار». يفهم EGC القصد، ويخزّن السياق، ويستدعيه فورًا في أي تبويب أو طرفية أو أداة أخرى على جهازك. دماغ واحد. كل الوكلاء. صفر أوامر للحفظ.

### ذاكرة مشروع دائمة

يمنح EGC كل وكيل ذكاء اصطناعي دماغًا دائمًا مشتركًا. يلتقط القرارات وسياق الجلسة والذاكرة العاملة والأنماط المتعلّمة، ثم يجعلها متاحة فورًا في أي طرفية أو IDE أو وكيل آخر تفتحه. حالة الجلسة وتاريخ المشروع والدروس المتراكمة تتدفق بسلاسة بين التبويبات والأدوات والزملاء: بلا مزامنة يدوية وبلا فقدان سياق. كل الذاكرة تعيش في `~/.egc` على جهازك، مشفّرة بـ AES-256-GCM، منفصلة لكل فرع، ولا تُرفع أبدًا إلى مستودعك.

### Guardian: حواجز أمان مدمجة

النصف الثاني من الدماغ يدير حواجز الأمان في الخلفية. يتحقق من الأوامر قبل تنفيذها، ويوقف الكتابات الخطرة، ويضغط السياق قبل أن يفيض، وينسّق المهام متعددة الخطوات بين الوكلاء، ويتعلم من كل تصحيح، كل ذلك دون أن تستدعي أداة واحدة. شبكة أمان خفية تُبقي السياق خفيفًا والأفعال آمنة والعمل مستقلًا.

### Token Crusher: الدماغ يصفّي الضجيج قبل أن يتذكر

الدماغ لا يتذكر فحسب: بل يصفّي. قبل أن يصل خرج الطرفية إلى النموذج، يضغط Token Crusher سجلات git وضجيج الاختبارات وبريد التثبيت وملفات JSON الضخمة حتى 90%، مع الحفاظ على كل خطأ وتحذير. شغّل `egc saved` لترى وفورات التوكنز المتراكمة، محسوبة محليًا وبلا تكلفة: جلسات أرخص وسياق يدوم.

---

## مكتبة الموجهات

كمكافأة، يمنحك EGC الوصول إلى 63 وكيلًا و230 مهارة و77 أمرًا، إضافة إلى 111 قاعدة: مختصون يراجعون كودك بأنفسهم، وأدلة أفضل الممارسات لكل لغة وموقف، واختصارات تنفذ سلاسل مهام كاملة، وقواعد أسلوب تحافظ على اتساق الكود. كلها مكتوبة من جلسات هندسية حقيقية لا من النظريات. لا تريد استخدام أي منها؟ لا بأس: الذاكرة الدائمة في EGC تعمل تمامًا كما هي.

---

## بداية سريعة

شغّل `egc watch` مرة واحدة وانسَ وجوده:

```bash
egc watch
```

غيّر السياق في Cursor فيظهر وحده في Gemini CLI وCopilot وWindsurf وZed أو أي وكيل طرفية. لا خطوات يدوية ولا حالة قديمة.

لمشاهدة نداءات الأدوات والتوكنز والتكاليف من وكلائك مباشرة في المتصفح:

```bash
egc dashboard
```

---

🌐 [English](../../README.md) · **العربية** · [Español](../es/README.md) · [हिन्दी](../hi/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [简体中文](../zh-CN/README.md)

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
